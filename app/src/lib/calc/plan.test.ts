import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allTechs, computeTechEffects, GameDataIndex, parseGameData, techClosure } from '../data';
import type { TechEffects } from '../data';
import { solveLP } from './lp';
import { provisionedRate } from '../validate/sim/run';
import { DEFAULT_MACHINE_HEADROOM, headroomMachines, machinesFor, planProduction } from './plan';
import type { PlanError, PlanRequest, ProductionPlan, Stage } from './types';

const fixturePath = fileURLToPath(new URL('../../../../data/fixture/dsp-fixture.json', import.meta.url));
const parsed = parseGameData(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown, 'dsp-fixture.json');
const data = new GameDataIndex(parsed);
const everything = allTechs(parsed);
const allEffects = computeTechEffects(parsed, everything);

const ASSEMBLER_MK1 = 2303;
const ASSEMBLER_MK3 = 2305;
const ARC_SMELTER = 2302;
const CHEMICAL_PLANT = 2309;
const REFINERY = 2308;
const MATRIX_LAB = 2901;

/** Processor chain on Mk.I assemblers and Arc Smelters (every recipe pinned: "all techs" would pick the fastest). */
const PROCESSOR_MK1 = {
  51: ASSEMBLER_MK1,
  50: ASSEMBLER_MK1,
  53: ASSEMBLER_MK1,
  1: ARC_SMELTER,
  3: ARC_SMELTER,
  59: ARC_SMELTER,
};
const ORES = [1001, 1002, 1003];

function request(over: Partial<PlanRequest> & Pick<PlanRequest, 'targetItemId'>): PlanRequest {
  return {
    quantity: { kind: 'rate', perSecond: 1 },
    finalFacilityItemId: ASSEMBLER_MK1,
    unlockedTechs: everything,
    suppliedItemIds: new Set(),
    facilityOverrides: {},
    recipeOverrides: {},
    proliferator: { tier: 0, mode: 'extra' },
    stationKind: 'planetary',
    ...over,
  };
}

/** The datasets.md base-tier machine for every recipe: Mk.I assembler, Arc Smelter, ..., Matrix Lab. */
const BASE_TIER_BY_TYPE: Record<string, number> = {
  ASSEMBLE: ASSEMBLER_MK1,
  SMELT: ARC_SMELTER,
  CHEMICAL: CHEMICAL_PLANT,
  REFINE: REFINERY,
  PARTICLE: 2310,
  RESEARCH: MATRIX_LAB,
};
const BASE_TIER_EVERYWHERE: Record<number, number> = Object.fromEntries(
  parsed.recipes.filter((r) => r.type in BASE_TIER_BY_TYPE).map((r) => [r.id, BASE_TIER_BY_TYPE[r.type]] as const),
);

const processorRequest = (over: Partial<PlanRequest> = {}): PlanRequest =>
  request({ targetItemId: 1303, suppliedItemIds: new Set(ORES), facilityOverrides: PROCESSOR_MK1, ...over });

async function planOf(req: PlanRequest, effects: TechEffects = allEffects): Promise<ProductionPlan> {
  const result = await planProduction(req, data, effects);
  if (!result.ok) throw new Error(`plan failed: ${result.error.kind}: ${result.error.message}`);
  return result.plan;
}

async function errorOf(req: PlanRequest, effects: TechEffects = allEffects): Promise<PlanError> {
  const result = await planProduction(req, data, effects);
  if (result.ok) throw new Error('expected the plan to fail');
  return result.error;
}

function stageFor(plan: ProductionPlan, recipeId: number): Stage {
  const stage = plan.stages.find((s) => s.recipeId === recipeId);
  if (!stage) throw new Error(`no stage for recipe ${recipeId}: [${plan.stages.map((s) => s.recipeId).join(', ')}]`);
  return stage;
}

const rateOf = (rates: { itemId: number; perSecond: number }[], itemId: number): number =>
  rates.find((r) => r.itemId === itemId)?.perSecond ?? 0;

/** Every stage output / input, import and export is carried exactly by the flows. */
function expectFlowsConsistent(plan: ProductionPlan): void {
  const sum = (match: (f: ProductionPlan['flows'][number]) => boolean): number =>
    plan.flows.filter(match).reduce((acc, f) => acc + f.perSecond, 0);
  plan.stages.forEach((stage, i) => {
    for (const o of stage.outputs) {
      expect(sum((f) => f.from === i && f.itemId === o.itemId)).toBeCloseTo(o.perSecond, 7);
    }
    for (const x of stage.inputs) {
      expect(sum((f) => f.to === i && f.itemId === x.itemId)).toBeCloseTo(x.perSecond, 7);
    }
  });
  const proliferatorItem = 1140 + plan.request.proliferator.tier;
  for (const imp of plan.imports) {
    if (plan.request.proliferator.tier > 0 && imp.itemId === proliferatorItem) continue;
    expect(sum((f) => f.from === 'import' && f.itemId === imp.itemId)).toBeCloseTo(imp.perSecond, 7);
  }
  for (const exp of plan.exports) {
    expect(sum((f) => f.to === 'export' && f.itemId === exp.itemId)).toBeCloseTo(exp.perSecond, 7);
  }
  for (const f of plan.flows) expect(f.perSecond).toBeGreaterThan(1e-9);
}

describe('planProduction: Processor chain (datasets.md "Test targets")', () => {
  it('builds recipes 51, 50, 53, 1, 3, 59 for 1 Processor/s from ores', async () => {
    const plan = await planOf(processorRequest());
    expect(plan.stages.map((s) => s.recipeId)).toEqual([51, 50, 53, 1, 3, 59]);
    expect(plan.warnings).toEqual([]);
  });

  it('sizes each stage: Processor 4, Circuit Board 4/3 -> 2, Microcrystalline 16/3 -> 6, Silicon 8, Iron 2, Copper 3', async () => {
    // The datasets.md counts are what each stage needs, so no headroom (the headroom sizes are in 'machine headroom' below).
    const plan = await planOf(processorRequest({ machineHeadroom: 0 }));
    const expectStage = (recipeId: number, exact: number, machines: number, buildingItemId: number) => {
      const s = stageFor(plan, recipeId);
      expect(s.exactMachines).toBeCloseTo(exact, 9);
      expect(s.machines).toBe(machines);
      expect(s.utilization).toBeCloseTo(exact / machines, 9);
      expect(s.buildingItemId).toBe(buildingItemId);
    };
    expectStage(51, 4, 4, ASSEMBLER_MK1);
    expectStage(50, 4 / 3, 2, ASSEMBLER_MK1);
    expectStage(53, 16 / 3, 6, ASSEMBLER_MK1);
    expectStage(59, 8, 8, ARC_SMELTER);
    expectStage(1, 2, 2, ARC_SMELTER);
    expectStage(3, 3, 3, ARC_SMELTER);
  });

  it('reports crafts/s, per-machine rate, speed and item totals per stage', async () => {
    const plan = await planOf(processorRequest());
    const s = stageFor(plan, 51);
    expect(s.craftsPerSecond).toBeCloseTo(1, 9);
    expect(s.perMachineCraftsPerSecond).toBeCloseTo(0.25, 9); // 0.75 / 3 s
    expect(s.effectiveSpeed).toBeCloseTo(0.75, 9);
    expect(s.proliferated).toBe(false);
    expect(s.inputs).toEqual([
      { itemId: 1301, perSecond: expect.closeTo(2, 9) },
      { itemId: 1302, perSecond: expect.closeTo(2, 9) },
    ]);
    expect(s.outputs).toEqual([{ itemId: 1303, perSecond: expect.closeTo(1, 9) }]);
    expect(s.workPowerW).toBe(270_000);
    expect(s.idlePowerW).toBe(12_000);
  });

  it('imports 2 Iron Ore, 3 Copper Ore and 8 Silicon Ore per second and exports only the Processor', async () => {
    // No headroom: the 4 Processor assemblers then make exactly the 1/s asked for (with it, 5 make 1.25/s).
    const plan = await planOf(processorRequest({ machineHeadroom: 0 }));
    expect(plan.imports).toEqual([
      { itemId: 1001, perSecond: expect.closeTo(2, 9) },
      { itemId: 1002, perSecond: expect.closeTo(3, 9) },
      { itemId: 1003, perSecond: expect.closeTo(8, 9) },
    ]);
    expect(plan.exports).toEqual([{ itemId: 1303, perSecond: expect.closeTo(1, 9) }]);
    expect(plan.actualTargetRate).toBeCloseTo(1, 9);
    expect(plan.proliferatorPerSecond).toBe(0);
  });

  it('needs one planetary station for 3 imports + 1 export, and lists the slots', async () => {
    const plan = await planOf(processorRequest());
    expect(plan.stationSlots).toEqual([
      { itemId: 1001, role: 'import' },
      { itemId: 1002, role: 'import' },
      { itemId: 1003, role: 'import' },
      { itemId: 1303, role: 'export' },
    ]);
    expect(plan.stationsNeeded).toBe(1);
  });

  it('carries every item through the flows', async () => {
    const plan = await planOf(processorRequest());
    expectFlowsConsistent(plan);
    // Stages run 51, 50, 53, 1, 3, 59: Iron Ingot (stage 3) feeds the Circuit Board stage (1).
    expect(plan.flows).toContainEqual({ itemId: 1101, from: 3, to: 1, perSecond: expect.closeTo(2, 9) });
    expect(plan.flows).toContainEqual({ itemId: 1303, from: 0, to: 'export', perSecond: expect.closeTo(1, 9) });
  });

  it('fills the plan power estimate', async () => {
    const plan = await planOf(processorRequest());
    // Work: 10 2/3 assemblers x 270 kW + 13 smelters x 360 kW.
    expect(plan.power.productionWorkW).toBeCloseTo((32 / 3) * 270_000 + 13 * 360_000, 3);
    expect(plan.power.productionIdleW).toBeGreaterThan(0); // 11 + 13 machines rounded up
    expect(plan.power.steadyW).toBeGreaterThan(plan.power.productionWorkW);
    expect(plan.power.peakW).toBeGreaterThan(plan.power.steadyW);
  });

  it('with Assembling Machine Mk.III on the Processor recipe, 2 machines are enough', async () => {
    // Enough to make the 1/s, so no headroom: 2 machines would run at 100 %, and with the default 1 % a 3rd is added.
    const plan = await planOf(
      processorRequest({ facilityOverrides: { ...PROCESSOR_MK1, 51: ASSEMBLER_MK3 }, machineHeadroom: 0 }),
    );
    const s = stageFor(plan, 51);
    expect(s.machines).toBe(2);
    expect(s.exactMachines).toBeCloseTo(2, 9);
    expect(s.buildingItemId).toBe(ASSEMBLER_MK3);
    expect(s.effectiveSpeed).toBeCloseTo(1.5, 9);
  });

  it('uses finalFacilityItemId for the target recipe and the fastest available building elsewhere', async () => {
    const plan = await planOf(
      request({ targetItemId: 1303, suppliedItemIds: new Set(ORES), finalFacilityItemId: ASSEMBLER_MK3 }),
    );
    expect(stageFor(plan, 51).buildingItemId).toBe(ASSEMBLER_MK3);
    expect(stageFor(plan, 50).buildingItemId).toBe(2318); // Re-composing Assembler, 3x
    expect(stageFor(plan, 1).buildingItemId).toBe(2319); // Negentropy Smelter, 3x
  });

  it('stops at supplied intermediates', async () => {
    const plan = await planOf(
      processorRequest({ suppliedItemIds: new Set([1301, 1302]) }),
    );
    expect(plan.stages.map((s) => s.recipeId)).toEqual([51]);
    expect(plan.imports).toEqual([
      { itemId: 1301, perSecond: expect.closeTo(2, 9) },
      { itemId: 1302, perSecond: expect.closeTo(2, 9) },
    ]);
  });
});

describe('planProduction: quantity', () => {
  it('buildings mode: 4 Mk.I assemblers make exactly 1 Processor/s', async () => {
    const plan = await planOf(processorRequest({ quantity: { kind: 'buildings', count: 4 } }));
    expect(stageFor(plan, 51).machines).toBe(4);
    expect(plan.actualTargetRate).toBeCloseTo(1, 9);
    expect(plan.exports[0]).toEqual({ itemId: 1303, perSecond: expect.closeTo(1, 9) });
  });

  it('buildings mode: 3 Mk.I assemblers make 0.75 Processor/s', async () => {
    const plan = await planOf(processorRequest({ quantity: { kind: 'buildings', count: 3 } }));
    expect(stageFor(plan, 51).machines).toBe(3);
    expect(stageFor(plan, 51).utilization).toBeCloseTo(1, 9);
    expect(plan.actualTargetRate).toBeCloseTo(0.75, 9);
  });

  it('rate mode: the machine ceiling raises actualTargetRate above the request, never below', async () => {
    const plan = await planOf(processorRequest({ quantity: { kind: 'rate', perSecond: 0.9 } }));
    const s = stageFor(plan, 51);
    expect(s.exactMachines).toBeCloseTo(3.6, 9);
    expect(s.machines).toBe(4);
    expect(plan.exports[0].perSecond).toBeCloseTo(0.9, 9);
    expect(plan.actualTargetRate).toBeCloseTo(1, 9);
    expect(plan.actualTargetRate).toBeGreaterThanOrEqual(0.9);
  });

  it('rejects a non-positive or non-finite quantity', async () => {
    for (const quantity of [
      { kind: 'rate', perSecond: 0 },
      { kind: 'rate', perSecond: Number.NaN },
      { kind: 'buildings', count: -2 },
    ] as const) {
      const error = await errorOf(processorRequest({ quantity }));
      expect(error.kind).toBe('infeasible');
    }
  });
});

describe('planProduction: fix round (overrides, tiny rates, supplied target, spray slots)', () => {
  it('buildings mode builds the recipe named by recipeOverrides for the target, not the first producer', async () => {
    // Hydrogen is also a by-product of Plasma Refining (16, listed first); the override picks X-ray Cracking (58).
    const plan = await planOf(
      request({
        targetItemId: 1120,
        suppliedItemIds: new Set([1007]),
        recipeOverrides: { 1120: 58 },
        finalFacilityItemId: REFINERY,
        facilityOverrides: { 58: REFINERY, 16: REFINERY },
        quantity: { kind: 'buildings', count: 2 },
      }),
    );
    const s = stageFor(plan, 58);
    expect(s.machines).toBe(2);
    expect(s.craftsPerSecond).toBeCloseTo(0.5, 9); // 2 refineries, 4 s per craft
    // R comes from recipe 58: 2 machines x 0.25 crafts/s x 3 Hydrogen per craft.
    expect(plan.exports[0]).toEqual({ itemId: 1120, perSecond: expect.closeTo(1.5, 9) });
    expect(plan.actualTargetRate).toBeGreaterThanOrEqual(1.5 - 1e-9);
    expectFlowsConsistent(plan);
  });

  it('buildings mode without an override still prefers the non-alternate recipe', async () => {
    const plan = await planOf(
      request({
        targetItemId: 1123,
        suppliedItemIds: new Set([1000, 1005, 1006, 1007, 1011]),
        finalFacilityItemId: CHEMICAL_PLANT,
        facilityOverrides: { 31: CHEMICAL_PLANT, 32: CHEMICAL_PLANT, 17: ARC_SMELTER, 24: CHEMICAL_PLANT, 16: REFINERY },
        quantity: { kind: 'buildings', count: 3 },
      }),
    );
    expect(stageFor(plan, 31).machines).toBe(3);
    expect(plan.stages.map((st) => st.recipeId)).not.toContain(32);
  });

  it('a rate too small to need any machine is infeasible, not an empty plan', async () => {
    const error = await errorOf(processorRequest({ quantity: { kind: 'rate', perSecond: 1e-10 } }));
    expect(error.kind).toBe('infeasible');
    expect(error.message).toMatch(/too small/i);
    const tinyBuildings = await errorOf(processorRequest({ quantity: { kind: 'buildings', count: 1e-12 } }));
    expect(tinyBuildings.kind).toBe('infeasible');
  });

  it('warns when the target is marked supplied but is built anyway', async () => {
    const plan = await planOf(processorRequest({ suppliedItemIds: new Set([...ORES, 1303]) }));
    expect(plan.stages.map((st) => st.recipeId)).toContain(51);
    expect(plan.warnings).toContain('Processor is marked supplied but is the target; it will be produced.');
    expect(plan.imports.map((i) => i.itemId)).not.toContain(1303);
  });

  it('gives a target that is also the spray supply one station slot, as an export', async () => {
    // Proliferator Mk.III (1143) as the target, sprayed with Mk.III: the plan both makes and imports it.
    const plan = await planOf(
      request({
        targetItemId: 1143,
        suppliedItemIds: new Set([1142, 1124]),
        proliferator: { tier: 3, mode: 'extra' },
      }),
    );
    expect(plan.proliferatorPerSecond).toBeGreaterThan(0);
    expect(rateOf(plan.imports, 1143)).toBeCloseTo(plan.proliferatorPerSecond, 9);
    expect(plan.exports[0].itemId).toBe(1143);
    const slotsFor1143 = plan.stationSlots.filter((slot) => slot.itemId === 1143);
    expect(slotsFor1143).toEqual([{ itemId: 1143, role: 'export' }]);
    const ids = plan.stationSlots.map((slot) => slot.itemId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(plan.stationsNeeded).toBe(Math.ceil(ids.length / 4));
    // Spray supply goes to coaters, not stages: no flow comes from the import.
    expect(plan.flows.filter((f) => f.itemId === 1143 && f.from === 'import')).toEqual([]);
  });

  it('merges a regular import of the spray item with the spray supply into one import and one slot', async () => {
    // Proliferator Mk.II eats Mk.I (supplied) and is sprayed with Mk.I as well.
    const plan = await planOf(
      request({
        targetItemId: 1142,
        suppliedItemIds: new Set([1141, 1112]),
        proliferator: { tier: 1, mode: 'extra' },
      }),
    );
    const stage = stageFor(plan, 107);
    const regular = stage.inputs.find((i) => i.itemId === 1141)?.perSecond ?? 0;
    expect(plan.imports.filter((i) => i.itemId === 1141)).toHaveLength(1);
    expect(rateOf(plan.imports, 1141)).toBeCloseTo(regular + plan.proliferatorPerSecond, 9);
    expect(plan.stationSlots.filter((slot) => slot.itemId === 1141)).toEqual([{ itemId: 1141, role: 'proliferator' }]);
    // The flows carry only the regular part of the import.
    const fromImport = plan.flows.filter((f) => f.itemId === 1141 && f.from === 'import').reduce((a, f) => a + f.perSecond, 0);
    expect(fromImport).toBeCloseTo(regular, 9);
  });
});

describe('planProduction: alternate recipes and by-products', () => {
  it('Graphene via recipe 32: 1 chemical plant, 1 Fire Ice/s in, 0.5 Hydrogen/s out (Review Focus #4)', async () => {
    const plan = await planOf(
      request({
        targetItemId: 1123,
        suppliedItemIds: new Set([1011]),
        recipeOverrides: { 1123: 32 },
        facilityOverrides: { 32: CHEMICAL_PLANT },
        finalFacilityItemId: CHEMICAL_PLANT,
      }),
    );
    expect(plan.stages.map((s) => s.recipeId)).toEqual([32]);
    expect(plan.stages[0].exactMachines).toBeCloseTo(1, 9);
    expect(plan.stages[0].machines).toBe(2); // 1 plant would run at 100 %: the default headroom adds one
    expect(plan.imports).toEqual([{ itemId: 1011, perSecond: expect.closeTo(1, 9) }]);
    expect(plan.exports).toEqual([
      { itemId: 1123, perSecond: expect.closeTo(1, 9) },
      { itemId: 1120, perSecond: expect.closeTo(0.5, 9) },
    ]);
    expect(plan.stationSlots).toContainEqual({ itemId: 1120, role: 'export' });
    expectFlowsConsistent(plan);
  });

  it('Graphene without an override and without Fire Ice picks recipe 31 (32 is pruned, not an error)', async () => {
    const plan = await planOf(
      request({
        targetItemId: 1123,
        suppliedItemIds: new Set([1000, 1005, 1006, 1007]),
        finalFacilityItemId: CHEMICAL_PLANT,
        facilityOverrides: { 31: CHEMICAL_PLANT, 17: ARC_SMELTER, 24: CHEMICAL_PLANT, 16: REFINERY },
      }),
    );
    const recipes = plan.stages.map((s) => s.recipeId);
    expect(recipes).toContain(31);
    expect(recipes).not.toContain(32);
    // Datasets: Graphene 1.5 chem plants, Graphite 3 smelters, Sulfuric Acid 0.75, Plasma Refining 1.5.
    expect(stageFor(plan, 31).exactMachines).toBeCloseTo(1.5, 9);
    expect(stageFor(plan, 17).exactMachines).toBeCloseTo(3, 9);
    expect(stageFor(plan, 24).exactMachines).toBeCloseTo(0.75, 9);
    expect(stageFor(plan, 16).exactMachines).toBeCloseTo(1.5, 9);
    expect(plan.imports).toEqual([
      { itemId: 1000, perSecond: expect.closeTo(0.5, 9) },
      { itemId: 1005, perSecond: expect.closeTo(1, 9) },
      { itemId: 1006, perSecond: expect.closeTo(3, 9) },
      { itemId: 1007, perSecond: expect.closeTo(0.75, 9) },
    ]);
    // Plasma Refining's Hydrogen has no consumer here, so it is exported (3/8 per second).
    expect(plan.exports).toEqual([
      { itemId: 1123, perSecond: expect.closeTo(1, 9) },
      { itemId: 1120, perSecond: expect.closeTo(0.375, 9) },
    ]);
    expectFlowsConsistent(plan);
  });

  it('Graphene with Fire Ice supplied and no override still works (the LP picks a recipe)', async () => {
    const plan = await planOf(
      request({
        targetItemId: 1123,
        suppliedItemIds: new Set([1000, 1005, 1006, 1007, 1011]),
        finalFacilityItemId: CHEMICAL_PLANT,
      }),
    );
    expect(plan.stages.length).toBeGreaterThan(0);
    expectFlowsConsistent(plan);
  });

  it('Electromagnetic Matrix runs in 3 Matrix Labs (kind lab), not an assembler', async () => {
    const plan = await planOf(
      request({
        targetItemId: 6001,
        suppliedItemIds: new Set([1202, 1301]),
        finalFacilityItemId: MATRIX_LAB,
        facilityOverrides: { 9: MATRIX_LAB },
      }),
    );
    expect(plan.stages).toHaveLength(1);
    const s = plan.stages[0];
    expect(s.recipeId).toBe(9);
    expect(data.building(s.buildingItemId)?.kind).toBe('lab');
    expect(s.buildingItemId).toBe(MATRIX_LAB);
    expect(s.exactMachines).toBeCloseTo(3, 9); // 3 s per craft at 1x
    expect(s.machines).toBe(4); // 3 labs would run at 100 %: the default headroom adds one
    expect(s.workPowerW).toBe(480_000);
  });

  it('a matrix recipe defaults to the fastest available lab (Self-evolution, 3x)', async () => {
    const plan = await planOf(
      request({ targetItemId: 6001, suppliedItemIds: new Set([1202, 1301]), finalFacilityItemId: 2902 }),
    );
    expect(plan.stages[0].buildingItemId).toBe(2902);
    expect(plan.stages[0].exactMachines).toBeCloseTo(1, 9);
    expect(plan.stages[0].machines).toBe(2); // 1 lab would run at 100 %: the default headroom adds one
    expect(plan.stages[0].effectiveSpeed).toBeCloseTo(3, 9);
  });

  it('a matrix recipe cannot be given an assembler', async () => {
    const error = await errorOf(
      request({
        targetItemId: 6001,
        suppliedItemIds: new Set([1202, 1301]),
        finalFacilityItemId: MATRIX_LAB,
        facilityOverrides: { 9: ASSEMBLER_MK1 },
      }),
    );
    expect(error.kind).toBe('facility-unavailable');
  });
});

describe('planProduction: errors', () => {
  it('Processor with no techs researched is target-locked and names the item and a tech', async () => {
    const none = techClosure(parsed, []);
    const error = await errorOf(
      processorRequest({ unlockedTechs: none }),
      computeTechEffects(parsed, none),
    );
    expect(error.kind).toBe('target-locked');
    if (error.kind !== 'target-locked') return;
    expect(error.itemId).toBe(1303);
    expect(error.message).toContain('Processor');
  });

  it('an item neither supplied nor craftable is no-recipe and names the raw item', async () => {
    const error = await errorOf(processorRequest({ suppliedItemIds: new Set([1001]) }));
    expect(error.kind).toBe('no-recipe');
    if (error.kind !== 'no-recipe') return;
    // Walking from the Processor: Circuit Board -> Copper Ingot -> Copper Ore.
    expect(error.itemId).toBe(1002);
    expect(error.message).toContain('Copper Ore');
  });

  it('nothing supplied at all still names an item rather than returning an empty plan', async () => {
    const error = await errorOf(processorRequest({ suppliedItemIds: new Set() }));
    expect(error.kind).toBe('no-recipe');
    expect(error.message).toMatch(/Iron Ore|Copper Ore|Silicon Ore|Stone/);
  });

  it('a supplied target with nothing to build is infeasible, not an empty plan', async () => {
    const error = await errorOf(request({ targetItemId: 1001, suppliedItemIds: new Set([1001]) }));
    expect(error.kind).toBe('infeasible');
  });

  it('an unknown target id is infeasible', async () => {
    const error = await errorOf(request({ targetItemId: 999_999 }));
    expect(error.kind).toBe('infeasible');
    expect(error.message).toContain('999999');
  });

  it('a facility override of the wrong type is facility-unavailable', async () => {
    const error = await errorOf(processorRequest({ facilityOverrides: { ...PROCESSOR_MK1, 51: ARC_SMELTER } }));
    expect(error.kind).toBe('facility-unavailable');
    if (error.kind !== 'facility-unavailable') return;
    expect(error.recipeId).toBe(51);
    expect(error.buildingItemId).toBe(ARC_SMELTER);
  });

  it('a facility override that is not unlocked yet is facility-unavailable', async () => {
    // Processor (1302) and Smelting Purification (1402, which needs the Arc Smelter's 1401), but not
    // Quantum Printing (1203), which is Assembling Machine Mk.III.
    const techs = techClosure(parsed, [1302, 1402]);
    const effects = computeTechEffects(parsed, techs);
    expect(effects.unlockedRecipes.has(51)).toBe(true);
    expect(effects.availableBuildings.has(ARC_SMELTER)).toBe(true);
    expect(effects.availableBuildings.has(ASSEMBLER_MK3)).toBe(false);
    const error = await errorOf(
      processorRequest({ unlockedTechs: techs, facilityOverrides: { ...PROCESSOR_MK1, 51: ASSEMBLER_MK3 } }),
      effects,
    );
    expect(error.kind).toBe('facility-unavailable');
    if (error.kind !== 'facility-unavailable') return;
    expect(error.recipeId).toBe(51);
    expect(error.buildingItemId).toBe(ASSEMBLER_MK3);
    expect(error.message).toContain('Assembling Machine Mk.III');
  });

  it('a recipe whose only buildings are locked is facility-unavailable, naming the building to unlock', async () => {
    const techs = techClosure(parsed, [1302]);
    const effects = computeTechEffects(parsed, techs);
    expect(effects.availableBuildings.has(ARC_SMELTER)).toBe(false);
    const error = await errorOf(processorRequest({ unlockedTechs: techs, facilityOverrides: {} }), effects);
    expect(error.kind).toBe('facility-unavailable');
    if (error.kind !== 'facility-unavailable') return;
    expect(error.buildingItemId).toBe(ARC_SMELTER);
    expect(error.message).toContain('Arc Smelter');
  });

  it('an override naming a building that does not exist is facility-unavailable', async () => {
    const error = await errorOf(processorRequest({ facilityOverrides: { ...PROCESSOR_MK1, 51: 424_242 } }));
    expect(error.kind).toBe('facility-unavailable');
  });

  it('a final facility that cannot make the target is facility-unavailable', async () => {
    const error = await errorOf(processorRequest({ facilityOverrides: {}, finalFacilityItemId: ARC_SMELTER }));
    expect(error.kind).toBe('facility-unavailable');
    if (error.kind !== 'facility-unavailable') return;
    expect(error.recipeId).toBe(51);
  });
});

describe('planProduction: stations (Review Focus #3)', () => {
  const quantumChip = (over: Partial<PlanRequest> = {}): PlanRequest =>
    request({
      targetItemId: 1305,
      suppliedItemIds: new Set([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]),
      ...over,
    });

  it('Quantum Chip from raw ores needs 3 or more planetary stations (4 kinds each)', async () => {
    const plan = await planOf(quantumChip());
    const slots = plan.stationSlots.length;
    expect(slots).toBeGreaterThan(8); // a handful of raw inputs, the chip and by-products
    expect(plan.stationsNeeded).toBeGreaterThanOrEqual(3);
    expect(plan.stationsNeeded).toBe(Math.ceil(slots / 4));
    expect(plan.exports[0].itemId).toBe(1305);
    expectFlowsConsistent(plan);
  });

  it('the interstellar station holds 5 kinds, so fewer stations are needed', async () => {
    const pls = await planOf(quantumChip());
    const ils = await planOf(quantumChip({ stationKind: 'interstellar' }));
    expect(ils.stationSlots.length).toBe(pls.stationSlots.length);
    expect(ils.stationsNeeded).toBe(Math.ceil(ils.stationSlots.length / 5));
    expect(ils.stationsNeeded).toBeLessThan(pls.stationsNeeded);
    expect(ils.power.stationChargeW).toBe(ils.stationsNeeded * 60e6);
  });

  it('matches the datasets machine totals for 1 Quantum Chip/s on Mk.I assemblers', async () => {
    const plan = await planOf(
      quantumChip({
        suppliedItemIds: new Set([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1120]),
        recipeOverrides: { 1114: 16 },
        facilityOverrides: BASE_TIER_EVERYWHERE,
      }),
    );
    const total = (type: string) =>
      plan.stages
        .filter((s) => data.recipe(s.recipeId).type === type)
        .reduce((sum, s) => sum + s.exactMachines, 0);
    expect(total('ASSEMBLE')).toBeCloseTo(96, 9);
    expect(total('SMELT')).toBeCloseTo(74, 9);
    expect(total('REFINE')).toBeCloseTo(26, 9);
    expect(total('CHEMICAL')).toBeCloseTo(33, 9);
    // Plasma Refining's Hydrogen (6.5/s) is used, so only 17.5/s is imported.
    expect(rateOf(plan.imports, 1120)).toBeCloseTo(17.5, 9);
    expect(plan.exports).toEqual([{ itemId: 1305, perSecond: expect.closeTo(1, 9) }]);
  });
});

describe('planProduction: Universe Matrix (datasets.md "Test targets")', () => {
  it('reproduces the datasets machine totals and boundary inputs for 1 Universe Matrix/s', async () => {
    const plan = await planOf(
      request({
        targetItemId: 6006,
        suppliedItemIds: new Set([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1120, 1121, 1208]),
        recipeOverrides: { 1114: 16 },
        finalFacilityItemId: MATRIX_LAB,
        facilityOverrides: BASE_TIER_EVERYWHERE,
      }),
    );
    const total = (buildingItemId: number) =>
      plan.stages.filter((s) => s.buildingItemId === buildingItemId).reduce((sum, s) => sum + s.exactMachines, 0);
    expect(total(MATRIX_LAB)).toBeCloseTo(54, 9);
    expect(total(2310)).toBeCloseTo(5, 9);
    expect(total(ASSEMBLER_MK1)).toBeCloseTo(368 / 3, 9);
    expect(total(ARC_SMELTER)).toBeCloseTo(150.5, 9);
    expect(total(REFINERY)).toBeCloseTo(34.5, 9);
    expect(total(CHEMICAL_PLANT)).toBeCloseTo(46.75, 9);
    // Boundary inputs; Hydrogen is 14 less the 9.625 that Plasma Refining and Mass-energy Storage give.
    expect(rateOf(plan.imports, 1000)).toBeCloseTo(7.5, 9);
    expect(rateOf(plan.imports, 1001)).toBeCloseTo(29, 9);
    expect(rateOf(plan.imports, 1007)).toBeCloseTo(17.25, 9);
    expect(rateOf(plan.imports, 1120)).toBeCloseTo(4.375, 9);
    expect(rateOf(plan.imports, 1121)).toBeCloseTo(5, 9);
    expect(rateOf(plan.imports, 1208)).toBeCloseTo(1, 9);
    expect(plan.exports).toEqual([{ itemId: 6006, perSecond: expect.closeTo(1, 9) }]);
    expectFlowsConsistent(plan);
  });
});

describe('planProduction: proliferator', () => {
  const mk3Extra = (over: Partial<PlanRequest> = {}): PlanRequest =>
    processorRequest({ proliferator: { tier: 3, mode: 'extra' }, ...over });

  it('Mk.III extra products on the Processor: 3.2 Mk.I assemblers, 1.6 + 1.6 inputs, 675 kW each', async () => {
    const plan = await planOf(mk3Extra());
    const s = stageFor(plan, 51);
    expect(s.exactMachines).toBeCloseTo(3.2, 9);
    expect(s.machines).toBe(4);
    expect(s.craftsPerSecond).toBeCloseTo(0.8, 9);
    expect(s.inputs).toEqual([
      { itemId: 1301, perSecond: expect.closeTo(1.6, 9) },
      { itemId: 1302, perSecond: expect.closeTo(1.6, 9) },
    ]);
    expect(s.outputs).toEqual([{ itemId: 1303, perSecond: expect.closeTo(1, 9) }]);
    expect(s.proliferated).toBe(true);
    expect(s.workPowerW).toBeCloseTo(675_000, 6);
    expect(s.idlePowerW).toBe(12_000);
    expect(plan.actualTargetRate).toBeCloseTo(1.25, 9); // 4 machines x 0.25 crafts/s x 1.25
  });

  it('imports unsprayed Mk.III proliferator: every stage input item uses one spray, 60 sprays per item', async () => {
    const plan = await planOf(mk3Extra());
    // Stage input totals (items/s), every stage proliferated and making 1.25x:
    //   Processor 3.2, Circuit Board 1.92, Microcrystalline 3.84, Iron 1.024, Copper 1.536, Silicon 4.096.
    const sprayed = 3.2 + 1.92 + 3.84 + 1.024 + 1.536 + 4.096;
    const summed = plan.stages.reduce((acc, s) => acc + s.inputs.reduce((a, i) => a + i.perSecond, 0), 0);
    expect(summed).toBeCloseTo(sprayed, 9);
    expect(plan.proliferatorPerSecond).toBeCloseTo(sprayed / 60, 9);
    expect(plan.proliferatorPerSecond).toBeGreaterThan(0);
    expect(rateOf(plan.imports, 1143)).toBeCloseTo(sprayed / 60, 9);
    expect(plan.stationSlots).toContainEqual({ itemId: 1143, role: 'proliferator' });
    expect(plan.stationSlots.filter((s) => s.itemId === 1143)).toHaveLength(1);
    // The extra products also shrink the raw imports: 1.024 / 1.536 / 4.096 instead of 2 / 3 / 8.
    expect(rateOf(plan.imports, 1001)).toBeCloseTo(1.024, 9);
    expect(rateOf(plan.imports, 1002)).toBeCloseTo(1.536, 9);
    expect(rateOf(plan.imports, 1003)).toBeCloseTo(4.096, 9);
    expectFlowsConsistent(plan);
  });

  it('adds the coater power and a station slot for the proliferator', async () => {
    const plain = await planOf(processorRequest());
    const plan = await planOf(mk3Extra());
    expect(plan.power.coatersW).toBeGreaterThan(0);
    expect(plain.power.coatersW).toBe(0);
    expect(plan.stationSlots.length).toBe(plain.stationSlots.length + 1);
  });

  it('Mk.III speed-up on the Processor: 2 Mk.I assemblers, unchanged inputs, 675 kW each', async () => {
    // 2 is what the stage needs; with the default headroom they would run at 100 % and a 3rd is added.
    const plan = await planOf(processorRequest({ proliferator: { tier: 3, mode: 'speed' }, machineHeadroom: 0 }));
    const s = stageFor(plan, 51);
    expect(s.exactMachines).toBeCloseTo(2, 9);
    expect(s.machines).toBe(2);
    expect(s.effectiveSpeed).toBeCloseTo(1.5, 9);
    expect(s.inputs[0].perSecond).toBeCloseTo(2, 9);
    expect(s.workPowerW).toBeCloseTo(675_000, 6);
  });

  it('Mk.I extra products give x1.125 and need 12 sprays per item', async () => {
    const plan = await planOf(processorRequest({ proliferator: { tier: 1, mode: 'extra' } }));
    const s = stageFor(plan, 51);
    expect(s.exactMachines).toBeCloseTo(4 / 1.125, 9);
    const summed = plan.stages.reduce((acc, st) => acc + st.inputs.reduce((a, i) => a + i.perSecond, 0), 0);
    expect(plan.proliferatorPerSecond).toBeCloseTo(summed / 12, 9);
    expect(rateOf(plan.imports, 1141)).toBeCloseTo(summed / 12, 9);
  });

  it('buildings mode accounts for the extra products: 4 machines make 1.25 Processor/s', async () => {
    const plan = await planOf(mk3Extra({ quantity: { kind: 'buildings', count: 4 } }));
    expect(stageFor(plan, 51).machines).toBe(4);
    expect(stageFor(plan, 51).exactMachines).toBeCloseTo(4, 9);
    expect(plan.exports[0].perSecond).toBeCloseTo(1.25, 9);
    expect(plan.actualTargetRate).toBeCloseTo(1.25, 9);
  });

  it('a recipe that cannot take extra products falls back to speed-up with a warning', async () => {
    // Assembling Machine Mk.II eats an Assembling Machine Mk.I, a non-productive item.
    const plan = await planOf(
      request({
        targetItemId: 2304,
        suppliedItemIds: new Set([2303, 1123, 1303]),
        proliferator: { tier: 3, mode: 'extra' },
      }),
    );
    expect(plan.stages.map((s) => s.recipeId)).toEqual([46]);
    const s = plan.stages[0];
    expect(s.proliferated).toBe(true);
    expect(s.effectiveSpeed).toBeCloseTo(1.5, 9); // 0.75 x 2
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('Assembling Machine Mk.II');
    expect(plan.warnings[0]).toMatch(/speed/i);
  });
});

describe('planProduction: machine headroom', () => {
  it('defaults to 1 %', () => {
    expect(DEFAULT_MACHINE_HEADROOM).toBe(0.01);
  });

  it('machinesFor adds one machine exactly when ceil(exact) would run above 99 %', () => {
    expect(machinesFor(5.977, 0.01)).toBe(7); // 99.6 % of 6
    expect(machinesFor(5.94, 0.01)).toBe(6); // exactly 99 % of 6 is still fine
    expect(machinesFor(5.9405, 0.01)).toBe(6); // the line is 1 / 1.01 = 99.0099 %, 5.940594 machines of 6
    expect(machinesFor(5.9407, 0.01)).toBe(7);
    expect(machinesFor(5.5, 0.01)).toBe(6);
    expect(machinesFor(0.3, 0.01)).toBe(1);
    expect(machinesFor(0.995, 0.01)).toBe(2); // one machine at 99.5 %
    // A stage that needs exactly 6 runs at 100 % on 6 machines, the worst case: it gets a 7th.
    expect(machinesFor(6, 0.01)).toBe(7);
    expect(machinesFor(6 + 1e-12, 0.01)).toBe(7);
  });

  it('machinesFor with no headroom is the old ceil, noise below 1e-9 ignored', () => {
    expect(machinesFor(5.977, 0)).toBe(6);
    expect(machinesFor(6, 0)).toBe(6);
    expect(machinesFor(6 + 1e-12, 0)).toBe(6);
    expect(machinesFor(6.001, 0)).toBe(7);
    expect(machinesFor(0.0001, 0)).toBe(1);
  });

  it('scales with the fraction asked for', () => {
    expect(machinesFor(5.5, 0.1)).toBe(7); // 5.5 / 6 is 91.7 %, but a 10 % headroom wants 6.05
    expect(machinesFor(5.4, 0.1)).toBe(6);
  });

  it('headroomMachines is what the headroom added to a stage', async () => {
    const plan = await planOf(processorRequest());
    expect(plan.stages.map(headroomMachines)).toEqual([1, 0, 0, 1, 1, 1]);
    const plain = await planOf(processorRequest({ machineHeadroom: 0 }));
    expect(plain.stages.map(headroomMachines)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('sizes the Processor chain with the default 1 % headroom', async () => {
    const plan = await planOf(processorRequest());
    const expectStage = (recipeId: number, exact: number, machines: number) => {
      const s = stageFor(plan, recipeId);
      expect(s.exactMachines).toBeCloseTo(exact, 9);
      expect(s.machines).toBe(machines);
      expect(s.utilization).toBeCloseTo(exact / machines, 9); // still exact / machines
    };
    expectStage(51, 4, 5); // 100 %
    expectStage(50, 4 / 3, 2); // 67 %: no headroom needed
    expectStage(53, 16 / 3, 6); // 89 %
    expectStage(59, 8, 9);
    expectStage(1, 2, 3);
    expectStage(3, 3, 4);
  });

  it('an explicit 0.01 is the default', async () => {
    const byDefault = await planOf(processorRequest());
    const explicit = await planOf(processorRequest({ machineHeadroom: 0.01 }));
    expect(explicit.stages.map((s) => s.machines)).toEqual(byDefault.stages.map((s) => s.machines));
  });

  it('machineHeadroom 0 reproduces the old counts', async () => {
    const plan = await planOf(processorRequest({ machineHeadroom: 0 }));
    expect(plan.stages.map((s) => [s.recipeId, s.machines])).toEqual([
      [51, 4],
      [50, 2],
      [53, 6],
      [1, 2],
      [3, 3],
      [59, 8],
    ]);
  });

  it('a stage at 99.5 % of its machines gets one more, one at 98.5 % does not (through the planner)', async () => {
    const tight = await planOf(processorRequest({ quantity: { kind: 'rate', perSecond: 0.995 } }));
    expect(stageFor(tight, 51).exactMachines).toBeCloseTo(3.98, 9);
    expect(stageFor(tight, 51).machines).toBe(5);
    const loose = await planOf(processorRequest({ quantity: { kind: 'rate', perSecond: 0.985 } }));
    expect(stageFor(loose, 51).exactMachines).toBeCloseTo(3.94, 9);
    expect(stageFor(loose, 51).machines).toBe(4);
  });

  it('buildings mode: the target stage keeps the user count, the stages behind it get headroom', async () => {
    const plan = await planOf(processorRequest({ quantity: { kind: 'buildings', count: 4 } }));
    const target = stageFor(plan, 51);
    expect(target.machines).toBe(4);
    expect(target.utilization).toBeCloseTo(1, 9);
    expect(headroomMachines(target)).toBe(0);
    expect(stageFor(plan, 1).machines).toBe(3); // 2 exact Arc Smelters
    expect(plan.exports[0]).toEqual({ itemId: 1303, perSecond: expect.closeTo(1, 9) });
    expect(plan.actualTargetRate).toBeCloseTo(1, 9);
  });

  it('buildings mode keeps the count however large the headroom is', async () => {
    for (const count of [1, 3, 4, 7]) {
      const plan = await planOf(processorRequest({ quantity: { kind: 'buildings', count }, machineHeadroom: 0.1 }));
      expect(stageFor(plan, 51).machines).toBe(count);
    }
  });

  it('buildings mode with the Mk.III extra-products target recipe pinned keeps its count too', async () => {
    const plan = await planOf(
      processorRequest({ quantity: { kind: 'buildings', count: 4 }, proliferator: { tier: 3, mode: 'extra' } }),
    );
    expect(stageFor(plan, 51).machines).toBe(4);
    expect(plan.exports[0].perSecond).toBeCloseTo(1.25, 9);
  });

  it('the target export, and so the provisioned rate, stays what was asked; the capacity counts the extra machine', async () => {
    const plan = await planOf(processorRequest());
    expect(stageFor(plan, 51).machines).toBe(5);
    expect(plan.exports[0]).toEqual({ itemId: 1303, perSecond: expect.closeTo(1, 9) });
    expect(provisionedRate(plan)).toBeCloseTo(1, 9);
    expect(plan.actualTargetRate).toBeCloseTo(1.25, 9); // 5 machines x 0.25 crafts/s
    const plain = await planOf(processorRequest({ machineHeadroom: 0 }));
    expect(provisionedRate(plain)).toBeCloseTo(1, 9);
    expect(plain.actualTargetRate).toBeCloseTo(1, 9);
  });

  it('power counts the extra machines idle', async () => {
    const plain = await planOf(processorRequest({ machineHeadroom: 0 }));
    const plan = await planOf(processorRequest());
    expect(plan.power.productionWorkW).toBeCloseTo(plain.power.productionWorkW, 3); // the work done is the same
    expect(plan.power.productionIdleW).toBeGreaterThan(plain.power.productionIdleW);
  });

  it('rejects a headroom that is negative or not a number', async () => {
    for (const machineHeadroom of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = await errorOf(processorRequest({ machineHeadroom }));
      expect(error.kind).toBe('infeasible');
      expect(error.message).toMatch(/headroom/i);
    }
  });
});

describe('solveLP', () => {
  it('minimises a small LP', async () => {
    const result = await solveLP({
      variables: [
        { name: 'x', cost: 1 },
        { name: 'y', cost: 2 },
      ],
      constraints: [{ name: 'c', terms: [{ variable: 'x', coef: 1 }, { variable: 'y', coef: 1 }], type: 'ge', rhs: 4 }],
    });
    expect(result.status).toBe('optimal');
    expect(result.values.x).toBeCloseTo(4, 9);
    expect(result.values.y).toBeCloseTo(0, 9);
  });

  it('reports an infeasible model', async () => {
    const result = await solveLP({
      variables: [{ name: 'x', cost: 1 }],
      constraints: [
        { name: 'a', terms: [{ variable: 'x', coef: 1 }], type: 'ge', rhs: 5 },
        { name: 'b', terms: [{ variable: 'x', coef: 1 }], type: 'le', rhs: 1 },
      ],
    });
    expect(result.status).not.toBe('optimal');
  });

  it('reports an unbounded model', async () => {
    const result = await solveLP({
      variables: [{ name: 'x', cost: -1 }],
      constraints: [],
    });
    expect(result.status).toBe('unbounded');
  });
});
