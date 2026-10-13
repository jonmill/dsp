import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allTechs, computeTechEffects, GameDataIndex, parseGameData } from '../data';
import { compatibleFacilities, planProduction, planWithSurplusSinks, plannableProducers } from './plan';
import type { Flow, ProductionPlan } from './types';
import { surplusExportsIn, surplusSinks } from './surplus';
import type { SurplusStage } from './surplus';

/** A stage that makes `outputs` and has `machines` of the `exact` it needs. */
const stage = (exact: number, machines: number, ...outputs: [number, number][]): SurplusStage => ({
  machines,
  exactMachines: exact,
  outputs: outputs.map(([itemId, perSecond]) => ({ itemId, perSecond })),
});
const flow = (itemId: number, from: number | 'import', to: number | 'export', perSecond = 1): Flow => ({ itemId, from, to, perSecond });
const none = new Set<number>();

describe('surplusSinks: the candidates for a sink (used only when validation finds a deadlock)', () => {
  it('lists the item that several stages make for one belt as a candidate, with the spare capacity of its producers as the rate', () => {
    // item 10 is made by stages 0 (10/s on 2 machines of 1.6 needed: spare 25 %) and 1 (4/s, exact), used by stage 2
    const stages = [stage(1.6, 2, [10, 10]), stage(1, 1, [10, 4]), stage(1, 1, [20, 1])];
    const flows = [flow(10, 0, 2, 10), flow(10, 1, 2, 4), flow(20, 2, 'export')];
    expect(surplusSinks(stages, flows, none, new Set([20]))).toEqual([{ itemId: 10, perSecond: expect.closeTo(2.5, 9) }]);
  });

  it('leaves out a lone producer that also makes what its consumers depend on (the loop through the producer): a sink there starves the consumers', () => {
    // stage 0 makes 10 and 11; 11 goes to stage 1, which makes 12 for stage 2; stage 2 also uses 10. Blocking 10 would stop 11, 12 and 2.
    // Its belt is a dead end that backs up to the consumers; a sink would turn it into a stream they catch 70 % of (see surplus.ts).
    const stages = [stage(1, 2, [10, 1], [11, 1]), stage(1, 1, [12, 1]), stage(1, 1, [13, 1])];
    const flows = [flow(10, 0, 2), flow(11, 0, 1), flow(12, 1, 2), flow(13, 2, 'export')];
    expect(surplusSinks(stages, flows, none, new Set([13]))).toEqual([]);
  });

  it('gives the belt that two stages share a sink even when one of them is such a producer', () => {
    // stage 0 makes 10 and 11 (11 feeds stage 1, which feeds stage 2); stage 3 also makes 10; stage 2 uses 10
    const stages = [stage(1, 2, [10, 1], [11, 1]), stage(1, 1, [12, 1]), stage(1, 1, [13, 1]), stage(1, 2, [10, 1])];
    const flows = [flow(10, 0, 2), flow(10, 3, 2), flow(11, 0, 1), flow(12, 1, 2), flow(13, 2, 'export')];
    expect(surplusSinks(stages, flows, none, new Set([13])).map((s) => s.itemId)).toEqual([10]);
  });

  it('leaves out a lone producer of a single item (it blocks and waits, nothing else depends on it)', () => {
    const stages = [stage(1, 2, [10, 1]), stage(1, 1, [11, 1])];
    expect(surplusSinks(stages, [flow(10, 0, 1), flow(11, 1, 'export')], none, new Set([11]))).toEqual([]);
  });

  it('leaves out an item that has a station already: imported as well (pooled), or exported', () => {
    const stages = [stage(1.6, 2, [10, 10]), stage(1, 1, [10, 4]), stage(1, 1, [20, 1])];
    const flows = [flow(10, 0, 2, 10), flow(10, 1, 2, 4), flow(20, 2, 'export')];
    expect(surplusSinks(stages, flows, new Set([10]), new Set([20]))).toEqual([]);
    expect(surplusSinks(stages, flows, none, new Set([10, 20]))).toEqual([]);
  });

  it('leaves out an item whose producers have no spare capacity', () => {
    const stages = [stage(2, 2, [10, 10]), stage(1, 1, [10, 4]), stage(1, 1, [20, 1])];
    const flows = [flow(10, 0, 2, 10), flow(10, 1, 2, 4), flow(20, 2, 'export')];
    expect(surplusSinks(stages, flows, none, new Set([20]))).toEqual([]);
  });
});

const fixturePath = fileURLToPath(new URL('../../../../data/fixture/dsp-fixture.json', import.meta.url));
const parsed = parseGameData(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown, 'dsp-fixture.json');
const data = new GameDataIndex(parsed);
const everything = allTechs(parsed);
const effects = computeTechEffects(parsed, everything);
const RAW_ITEMS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1030, 1031];

async function planOf(name: string, tier: 0 | 3): Promise<ProductionPlan> {
  const item = data.data.items.find((i) => i.name === name)!;
  const facility = compatibleFacilities(plannableProducers(item.id, data, effects)[0], data).find((b) => effects.availableBuildings.has(b.itemId))!;
  const result = await planProduction(
    {
      targetItemId: item.id,
      quantity: { kind: 'rate', perSecond: 1 },
      finalFacilityItemId: facility.itemId,
      unlockedTechs: everything,
      suppliedItemIds: new Set(RAW_ITEMS),
      facilityOverrides: {},
      recipeOverrides: {},
      proliferator: { tier, mode: 'extra' },
      stationKind: 'planetary',
    },
    data,
    effects,
  );
  if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
  return result.plan;
}

describe('the plan of Deuteron Fuel Rod', () => {
  const maxKinds = data.data.buildings.find((b) => b.station !== undefined && !b.station.isStellar)!.station!.maxItemKinds;

  it('Mk.III: the hydrogen two stages make and Deuterium uses is a candidate, and the plan has no slot, station or power for a sink', async () => {
    const plan = await planOf('Deuteron Fuel Rod', 3);
    const hydrogen = data.data.items.find((i) => i.name === 'Hydrogen')!.id;
    expect(plan.surplus).toEqual([{ itemId: hydrogen, perSecond: expect.any(Number) }]);
    expect(plan.surplus![0].perSecond).toBeGreaterThan(0);
    expect(plan.stationSlots.map((s) => s.itemId)).not.toContain(hydrogen); // the plan shows no surplus export while no layout needs one
    expect(plan.exports.map((e) => e.itemId)).not.toContain(hydrogen);
  });

  it('planWithSurplusSinks adds the export slot, and the stations and power that follow; switched off again it is the planner\'s plan', async () => {
    const plan = await planOf('Deuteron Fuel Rod', 3);
    const hydrogen = data.data.items.find((i) => i.name === 'Hydrogen')!.id;
    const on = planWithSurplusSinks(plan, true, data, effects);
    expect(on.stationSlots).toEqual([...plan.stationSlots, { itemId: hydrogen, role: 'export' }]);
    expect(on.stationsNeeded).toBe(Math.max(1, Math.ceil(on.stationSlots.length / maxKinds)));
    expect(on.surplus).toEqual(plan.surplus); // the candidates stay: the netlist looks for their slots
    expect(on.exports).toEqual(plan.exports); // not an export of the plan
    expect(on.flows).toEqual(plan.flows); // the plan's own balance is untouched
    expect(planWithSurplusSinks(on, true, data, effects).stationSlots).toEqual(on.stationSlots); // idempotent
    const off = planWithSurplusSinks(on, false, data, effects);
    expect(off).toEqual(plan);
    // every stage's flows still add up to what it makes: the surplus is not a flow
    plan.stages.forEach((s, i) => {
      for (const o of s.outputs) {
        const out = on.flows.filter((f) => f.from === i && f.itemId === o.itemId).reduce((n, f) => n + f.perSecond, 0);
        expect(out).toBeCloseTo(o.perSecond, 9);
      }
    });
  });

  it('a slot that pushes the plan over the station\'s item kinds needs another station, and the power says so', async () => {
    const plan = await planOf('Deuteron Fuel Rod', 3);
    // fill the first station: as many item kinds as it holds in the slots before the sink's
    const crowded = { ...plan, stationSlots: Array.from({ length: maxKinds }, (_, i) => ({ itemId: 90_000 + i, role: 'import' as const })) };
    const on = planWithSurplusSinks(crowded, true, data, effects);
    expect(on.stationsNeeded).toBe(2);
    expect(on.power.stationChargeW).toBeCloseTo(planWithSurplusSinks(crowded, false, data, effects).power.stationChargeW * 2, 3);
  });

  it('a plan without candidates is returned as it is: the Processor', async () => {
    const plan = await planOf('Processor', 0);
    expect(plan.surplus ?? []).toEqual([]);
    expect(planWithSurplusSinks(plan, true, data, effects)).toBe(plan);
  });

  it('surplusExportsIn: the candidates a layout has a station slot for, none for a layout built without sinks', async () => {
    const plan = await planOf('Deuteron Fuel Rod', 3);
    const hydrogen = data.data.items.find((i) => i.name === 'Hydrogen')!.id;
    const station = (...itemIds: number[]) => ({ buildings: [{ station: { slots: itemIds.map((itemId) => ({ itemId })) } }] }) as never;
    expect(surplusExportsIn(station(1101, hydrogen), plan).map((s) => s.itemId)).toEqual([hydrogen]);
    expect(surplusExportsIn(station(1101), plan)).toEqual([]);
    expect(surplusExportsIn({ buildings: [] }, plan)).toEqual([]);
    expect(surplusExportsIn(station(hydrogen), {})).toEqual([]);
  });

  it('what is a candidate is never imported or exported: those belts end at a station already', async () => {
    for (const [name, tier] of [['Deuteron Fuel Rod', 0], ['Deuteron Fuel Rod', 3], ['Crystal Explosive Unit', 0], ['Quantum Chip', 0]] as const) {
      const plan = await planOf(name, tier);
      const stationed = new Set([...plan.imports, ...plan.exports].map((r) => r.itemId));
      for (const s of plan.surplus ?? []) expect(stationed.has(s.itemId), `${name} ${tier}: ${s.itemId}`).toBe(false);
    }
  });
});
