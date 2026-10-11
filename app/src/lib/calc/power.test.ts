import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allTechs, computeTechEffects, GameDataIndex, parseGameData } from '../data';
import { estimatePower } from './power';
import type { PlanRequest, ProductionPlan, Stage } from './types';

const fixturePath = fileURLToPath(new URL('../../../../data/fixture/dsp-fixture.json', import.meta.url));
const parsed = parseGameData(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown, 'dsp-fixture.json');
const data = new GameDataIndex(parsed);
const effects = computeTechEffects(parsed, allTechs(parsed));

const request = (over: Partial<PlanRequest> = {}): PlanRequest => ({
  targetItemId: 1303,
  quantity: { kind: 'rate', perSecond: 1 },
  finalFacilityItemId: 2303,
  unlockedTechs: new Set(),
  suppliedItemIds: new Set(),
  facilityOverrides: {},
  recipeOverrides: {},
  proliferator: { tier: 0, mode: 'extra' },
  stationKind: 'planetary',
  ...over,
});

/** An Assembling Machine Mk.I stage (270 kW work, 12 kW idle) with `machines` and `exactMachines`. */
const stage = (machines: number, exactMachines: number, over: Partial<Stage> = {}): Stage => ({
  recipeId: 51,
  buildingItemId: 2303,
  machines,
  exactMachines,
  craftsPerSecond: exactMachines / 4,
  utilization: exactMachines / machines,
  inputs: [
    { itemId: 1301, perSecond: 2 },
    { itemId: 1302, perSecond: 2 },
  ],
  outputs: [{ itemId: 1303, perSecond: 1 }],
  perMachineCraftsPerSecond: 0.25,
  proliferated: false,
  effectiveSpeed: 0.75,
  workPowerW: 270_000,
  idlePowerW: 12_000,
  ...over,
});

const plan = (stages: Stage[], over: Partial<ProductionPlan> = {}): Omit<ProductionPlan, 'power'> => ({
  request: request(),
  stages,
  flows: [],
  imports: [],
  exports: [{ itemId: 1303, perSecond: 1 }],
  actualTargetRate: 1,
  stationSlots: [],
  stationsNeeded: 1,
  proliferatorPerSecond: 0,
  warnings: [],
  ...over,
});

describe('estimatePower', () => {
  it('4 fully used Mk.I assemblers draw 4 x 270 kW and no idle power', () => {
    const p = estimatePower(plan([stage(4, 4)]), data, effects);
    expect(p.productionWorkW).toBe(4 * 270_000);
    expect(p.productionIdleW).toBe(0);
  });

  it('at utilization 0.5 half the work power is drawn and the rest idles', () => {
    const p = estimatePower(plan([stage(4, 2)]), data, effects);
    expect(p.productionWorkW).toBe(540_000);
    expect(p.productionIdleW).toBe(2 * 12_000);
  });

  it('uses the per-machine work power, which already includes the proliferator multiplier', () => {
    const p = estimatePower(plan([stage(4, 4, { workPowerW: 675_000, proliferated: true })]), data, effects);
    expect(p.productionWorkW).toBe(4 * 675_000);
  });

  it('charges 60 MW per Interstellar Logistics Station', () => {
    const one = estimatePower(plan([stage(4, 4)], { request: request({ stationKind: 'interstellar' }) }), data, effects);
    expect(one.stationChargeW).toBe(60e6);
    const two = estimatePower(
      plan([stage(4, 4)], { request: request({ stationKind: 'interstellar' }), stationsNeeded: 2 }),
      data,
      effects,
    );
    expect(two.stationChargeW).toBe(120e6);
  });

  it('charges 12 MW per Planetary Logistics Station and honours a charge override', () => {
    const pls = estimatePower(plan([stage(4, 4)], { stationsNeeded: 3 }), data, effects);
    expect(pls.stationChargeW).toBe(36e6);
    const custom = estimatePower(
      plan([stage(4, 4)], { request: request({ stationChargePerTick: 50_000 }) }),
      data,
      effects,
    );
    expect(custom.stationChargeW).toBe(3e6);
  });

  it('estimates two Mk.III sorters per machine at 50 % duty (half work, half idle)', () => {
    // Sorter Mk.III: 1200 J/tick work, 150 J/tick idle -> (1200 + 150) / 2 x 60 = 40.5 kW each.
    const p = estimatePower(plan([stage(4, 4)]), data, effects);
    expect(p.sortersW).toBeCloseTo(8 * 40_500, 6);
  });

  it('puts one spray coater (90 kW) on each distinct input of a proliferated stage', () => {
    const plain = estimatePower(plan([stage(4, 4)]), data, effects);
    expect(plain.coatersW).toBe(0);
    const sprayed = estimatePower(plan([stage(4, 4, { proliferated: true })]), data, effects);
    expect(sprayed.coatersW).toBe(2 * 90_000);
  });

  it('steady power adds a tenth of the station charge; peak adds all of it and every machine working', () => {
    const p = estimatePower(plan([stage(4, 2)]), data, effects);
    const sorterWork = 8 * 1200 * 60;
    expect(p.steadyW).toBeCloseTo(p.productionWorkW + p.productionIdleW + p.sortersW + p.coatersW + 0.1 * p.stationChargeW, 6);
    expect(p.peakW).toBeCloseTo(4 * 270_000 + sorterWork + p.coatersW + p.stationChargeW, 6);
    expect(p.peakW).toBeGreaterThan(p.steadyW);
  });
});
