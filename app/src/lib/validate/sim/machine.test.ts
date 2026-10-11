import { describe, expect, it } from 'vitest';
import { fixtureData, ITEM } from '../testkit';
import { MachineSim, machineConfig, splitIncLevel } from './machine';
import type { MachineConfig } from './machine';

const ORE = 1001;
const INGOT = 1101;
const GEAR = 1201;
const COIL = 1202;
const MAGNET = 1102;
const COPPER = 1104;
const HYDROGEN = 1120;
const REFINED_OIL = 1114;
const CRUDE = 1007;

const SMELTER = 2302;
const ASM_MK1 = 2303;
const ASM_MK2 = 2304;
const ASM_MK3 = 2305;
const REFINERY = 2308;
const MATRIX_LAB = ITEM.matrixLab;
const EVOLUTION_LAB = 2902;

const RECIPE = { ingot: 1, gear: 5, coil: 6, matrix: 9, refine: 16, xray: 58, gravity: 102 } as const;

function configOf(buildingItemId: number, recipeId: number, mode: 0 | 1 = 0): MachineConfig {
  const def = fixtureData.building(buildingItemId);
  if (!def) throw new Error(`no building ${buildingItemId}`);
  return machineConfig(def, fixtureData.recipe(recipeId), fixtureData, mode);
}

const machineOf = (buildingItemId: number, recipeId: number, mode: 0 | 1 = 0): MachineSim =>
  new MachineSim(configOf(buildingItemId, recipeId, mode));

/** A machine config with a made-up recipe of `timeTicks`, for thresholds the fixture recipes do not hit. */
function customConfig(over: Partial<MachineConfig>): MachineConfig {
  return { ...configOf(ASM_MK2, RECIPE.gear), ...over };
}

/** Serve `count` of `item`, each carrying `incPerItem` points. */
function serve(m: MachineSim, item: number, count: number, incPerItem = 0): void {
  expect(m.insert(item, count, count * incPerItem)).toBe(true);
}

/**
 * Run `ticks` ticks. Each tick tops up every ingredient the machine wants (an unlimited feeder, `incPerItem`
 * points on each item) and, if `drain`, takes every product away.
 */
function run(m: MachineSim, ticks: number, opts: { incPerItem?: number; drain?: boolean; power?: number } = {}): Map<number, number> {
  const { incPerItem = 0, drain = true, power = 1 } = opts;
  const out = new Map<number, number>();
  const ingredients = m.ingredientItems();
  const products = m.productItems();
  for (let t = 0; t < ticks; t++) {
    for (const item of ingredients) if (m.needs(item)) m.insert(item, 1, incPerItem);
    m.tick(power);
    if (!drain) continue;
    for (const item of products) {
      for (let p = m.pickProduct(item, () => true); p !== null; p = m.pickProduct(item, () => true)) {
        out.set(item, (out.get(item) ?? 0) + p.count);
      }
    }
  }
  return out;
}

describe('MachineSim throughput', () => {
  it('an iron smelter with an unlimited ore feeder makes 1 ingot per second', () => {
    const m = machineOf(SMELTER, RECIPE.ingot);
    const out = run(m, 3600); // 60 s
    expect(Math.abs((out.get(INGOT) ?? 0) - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.crafts - 60)).toBeLessThanOrEqual(1);
  });

  it('crafts at building speed: Mk.I assembler 0.75x, Mk.III 1.5x', () => {
    const mk1 = machineOf(ASM_MK1, RECIPE.gear);
    const mk3 = machineOf(ASM_MK3, RECIPE.gear);
    expect(Math.abs((run(mk1, 3600).get(GEAR) ?? 0) - 45)).toBeLessThanOrEqual(1);
    expect(Math.abs((run(mk3, 3600).get(GEAR) ?? 0) - 90)).toBeLessThanOrEqual(1);
  });

  it('a recipe with several ingredients waits for all of them', () => {
    const m = machineOf(ASM_MK2, RECIPE.coil); // 2 magnets + 1 copper -> 2 coils
    serve(m, MAGNET, 2);
    for (let t = 0; t < 200; t++) m.tick(1); // no copper: never starts
    expect(m.crafts).toBe(0);
    expect(m.state).toBe('starved');
    serve(m, COPPER, 1);
    m.tick(1);
    expect(m.state).toBe('busy');
    for (let t = 0; t < 60; t++) m.tick(1);
    expect(m.crafts).toBe(1);
    expect(m.produced(COIL)).toBe(2);
  });

  it('runs at power x speed, and freezes below 10 % power', () => {
    const half = machineOf(ASM_MK2, RECIPE.gear);
    expect(Math.abs((run(half, 3600, { power: 0.5 }).get(GEAR) ?? 0) - 30)).toBeLessThanOrEqual(1);
    const frozen = machineOf(ASM_MK2, RECIPE.gear);
    serve(frozen, INGOT, 4);
    for (let t = 0; t < 600; t++) frozen.tick(0.09);
    expect(frozen.crafts).toBe(0);
    expect(frozen.served(INGOT)).toBe(4); // it did not even start
    expect(frozen.state).toBe('unpowered');
  });
});

describe('MachineSim needs threshold N', () => {
  it('a 1 s recipe at 1x wants 4 crafts worth, and no more once 4 are served', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear);
    expect(m.careNeeds).toBe(true);
    for (let served = 0; served < 4; served++) {
      expect(m.needs(INGOT)).toBe(true);
      expect(m.needsAny()).toBe(true);
      serve(m, INGOT, 1);
    }
    expect(m.needs(INGOT)).toBe(false);
    expect(m.needsAny()).toBe(false);
    expect(m.needs(ORE)).toBe(false); // not an ingredient
  });

  it('scales the threshold with the ingredient count', () => {
    const m = machineOf(ASM_MK2, RECIPE.coil); // 2 magnets, 1 copper per craft
    serve(m, MAGNET, 7);
    expect(m.needs(MAGNET)).toBe(true);
    serve(m, MAGNET, 1);
    expect(m.needs(MAGNET)).toBe(false); // 8 = 4 crafts x 2
    expect(m.needs(COPPER)).toBe(true);
    expect(m.needsAny()).toBe(true);
    serve(m, COPPER, 4);
    expect(m.needs(COPPER)).toBe(false);
    expect(m.needsAny()).toBe(false);
  });

  it.each([
    // [speed (10000 = 1x), recipe ticks, expected N], from MX §4.3
    [10000, 60, 4],
    [10000, 120, 2],
    [15000, 60, 5],
    [10000, 30, 7],
    [10000, 600, 2], // floor(0.3) + 1 = 1, raised to the minimum 2
  ])('speed %i, %i-tick recipe: N = %i', (speed, ticks, n) => {
    const m = new MachineSim(customConfig({ speed, timeTicks: ticks }));
    serve(m, INGOT, n - 1);
    expect(m.needs(INGOT)).toBe(true);
    serve(m, INGOT, 1);
    expect(m.needs(INGOT)).toBe(false);
  });

  it('N follows the speed-up of the running craft', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear, 1);
    serve(m, INGOT, 4, 4); // Mk.III sprayed: L = 4, accTable 1000 => 2x
    m.tick(1); // starts a craft: consumes 1, speed override 2x => N = 7
    expect(m.served(INGOT)).toBe(3);
    serve(m, INGOT, 3);
    expect(m.needs(INGOT)).toBe(true); // 6 < 7
    serve(m, INGOT, 1);
    expect(m.needs(INGOT)).toBe(false);
  });
});

describe('MachineSim output blocking', () => {
  it('an assembler stops with 10 crafts of product buffered and draws idle power', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear);
    run(m, 2000, { drain: false }); // 33 s: 33 crafts would fit in time
    expect(m.produced(GEAR)).toBe(10);
    expect(m.crafts).toBe(10);
    expect(m.state).toBe('blocked');
    const def = fixtureData.building(ASM_MK2)!;
    expect(m.powerDemand()).toBe(def.power.idlePerTick);
    expect(m.stalledTicks).toBeGreaterThan(1300);
    // Taking one product away lets the finished craft go out and the next one start.
    expect(m.pickProduct(GEAR, () => true)).toEqual({ item: GEAR, count: 1, inc: 0 });
    m.tick(1);
    expect(m.produced(GEAR)).toBe(10);
    expect(m.crafts).toBe(11);
    expect(m.state).toBe('busy');
  });

  it('adds a bonus batch even when the buffer is full: the output check does not apply to it', () => {
    // Mk.II proliferator (+20 %): the 5th craft's bonus lands on top of 10 buffered items.
    const m = machineOf(ASM_MK2, RECIPE.gear, 0);
    run(m, 6000, { drain: false, incPerItem: 2 });
    expect(m.state).toBe('blocked');
    expect(m.crafts).toBe(9);
    expect(m.produced(GEAR)).toBe(11);
  });

  it('a smelter stops at 100 items', () => {
    const m = machineOf(SMELTER, RECIPE.ingot);
    run(m, 7000, { drain: false });
    expect(m.produced(INGOT)).toBe(100);
    expect(m.state).toBe('blocked');
  });

  it('a refinery stops at 20 crafts of any one product: an undrained byproduct stalls it', () => {
    const m = machineOf(REFINERY, RECIPE.refine); // 1 hydrogen + 2 refined oil per craft
    let oil = 0;
    for (let t = 0; t < 240 * 60; t++) {
      for (const item of m.ingredientItems()) if (m.needs(item)) m.insert(item, 1, 0);
      m.tick(1);
      // Drain only the refined oil.
      for (let p = m.pickProduct(REFINED_OIL, () => true); p !== null; p = m.pickProduct(REFINED_OIL, () => true)) oil += 1;
    }
    expect(m.produced(HYDROGEN)).toBe(20);
    expect(m.crafts).toBe(20);
    expect(oil).toBe(40);
    expect(m.state).toBe('blocked');
  });

  it('blocked time and starved time are counted apart', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear);
    for (let t = 0; t < 10; t++) m.tick(1);
    expect(m.starvedTicks).toBe(10);
    expect(m.busyTicks).toBe(0);
    run(m, 100, { drain: false });
    expect(m.busyTicks).toBe(100);
    expect(m.crafts).toBe(1);
    m.resetStats();
    expect([m.crafts, m.busyTicks, m.stalledTicks, m.starvedTicks]).toEqual([0, 0, 0, 0]);
    expect(m.produced(GEAR)).toBe(1); // stats only: the buffers are kept
  });
});

describe('MachineSim proliferator', () => {
  it('extra products at Mk.III (+25 %) turn 400 crafts into 500 products', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear, 0);
    const out = run(m, 400 * 60 + 5, { incPerItem: 4 });
    expect(Math.abs(m.crafts - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs((out.get(GEAR) ?? 0) - 500)).toBeLessThanOrEqual(1);
  });

  it.each([
    [1, 112.5],
    [2, 120],
    [4, 125],
  ])('extra products at ability %i give +%f per 100 crafts', (ability, per100) => {
    const m = machineOf(ASM_MK2, RECIPE.gear, 0);
    const out = run(m, 800 * 60 + 5, { incPerItem: ability });
    expect(Math.abs((out.get(GEAR) ?? 0) - 8 * per100)).toBeLessThanOrEqual(1);
  });

  it('the speed-up at Mk.III doubles the rate and leaves the products per craft alone', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear, 1);
    const out = run(m, 3600, { incPerItem: 4 });
    expect(Math.abs((out.get(GEAR) ?? 0) - 120)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.crafts - 120)).toBeLessThanOrEqual(2);
  });

  it('a recipe that cannot take extra products gets the speed-up even in extra mode', () => {
    const m = machineOf(REFINERY, RECIPE.xray, 0); // nonProductive
    const out = run(m, 240 * 20, { incPerItem: 4 });
    // 240-tick craft: 20 crafts un-proliferated, 40 at the doubled speed. No bonus graphite.
    expect(Math.abs(m.crafts - 40)).toBeLessThanOrEqual(1);
    expect(out.get(1109)).toBe(m.crafts);
  });

  it('uses the lowest level across the ingredients: an unsprayed one means no bonus', () => {
    const feedCoil = (copperInc: number): { crafts: number; coils: number } => {
      const m = machineOf(ASM_MK2, RECIPE.coil, 0);
      let coils = 0;
      for (let t = 0; t < 60 * 100; t++) {
        if (m.needs(MAGNET)) m.insert(MAGNET, 1, 4);
        if (m.needs(COPPER)) m.insert(COPPER, 1, copperInc);
        m.tick(1);
        for (let p = m.pickProduct(COIL, () => true); p !== null; p = m.pickProduct(COIL, () => true)) coils += 1;
      }
      return { crafts: m.crafts, coils };
    };
    const mixed = feedCoil(0);
    const sprayed = feedCoil(4);
    expect(mixed.coils).toBe(mixed.crafts * 2);
    expect(Math.abs(sprayed.crafts - mixed.crafts)).toBeLessThanOrEqual(1);
    expect(sprayed.coils).toBeGreaterThan(sprayed.crafts * 2 * 1.24); // +25 % on 2 coils per craft
  });

  it('averages the points over what is served', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear, 1);
    serve(m, INGOT, 1, 4);
    serve(m, INGOT, 1, 0);
    // 2 items with 4 points between them: level 2, so the speed override is 1 + accTable[2] / 1000 = 1.5x.
    m.tick(1);
    expect(m.speedOverride).toBe(15000);
  });
});

describe('splitIncLevel (the game\'s split_inc_level)', () => {
  it.each([
    // [items, points, taken] -> level, items left, points left
    [4, 16, 1, 4, 3, 12], // every item holds 4: the level is 4
    [5, 0, 2, 0, 3, 0], // nothing sprayed
    [4, 10, 1, 2, 3, 8], // 2 points each and 2 items hold one more: the taken item is a plain 2
    [3, 2, 2, 1, 1, 1], // 2 items hold 1, 1 holds 0: taking 2 of 3 must include a 1-item, so level 1, 1 point stays
    [3, 2, 1, 0, 2, 2], // taking 1 of 3 can be the unsprayed one
    [2, 5, 2, 3, 0, 0], // taking everything takes every point
    [3, 3, 3, 1, 0, 0],
    [1, 4, 1, 4, 0, 0],
  ])('%i items with %i points, taking %i: level %i, %i items and %i points stay', (count, total, take, level, left, leftInc) => {
    expect(splitIncLevel(count, total, take)).toEqual({ level, left, leftInc });
  });

  it('conserves items and points, and the level is the floor or ceiling of the average', () => {
    for (let count = 1; count <= 9; count++) {
      for (let total = 0; total <= 45; total++) {
        for (let take = 1; take <= count; take++) {
          const { level, left, leftInc } = splitIncLevel(count, total, take);
          expect(left).toBe(count - take);
          expect(leftInc).toBeGreaterThanOrEqual(0);
          expect(leftInc).toBeLessThanOrEqual(total);
          const avg = Math.floor(total / count);
          expect(level === avg || level === avg + 1).toBe(true);
          // What stays cannot hold more than 1 point above its share, nor the taken items less than they were given.
          expect(leftInc).toBeLessThanOrEqual(avg * left + Math.min(left, total - avg * count));
        }
      }
    }
  });

  it('feeds the machine: a craft on a stack with mixed points runs at the rounded level and leaves the rest', () => {
    const m = machineOf(ASM_MK2, RECIPE.coil, 1); // 2 magnets + 1 copper per craft, speed-up mode
    serve(m, MAGNET, 1, 4);
    serve(m, MAGNET, 1, 0);
    serve(m, MAGNET, 1, 4); // 3 magnets with 8 points: 2 each and 2 items hold one more
    serve(m, COPPER, 1, 4); // level 4
    m.tick(1);
    // Magnets: taking 2 of 3 with 8 points -> level 3 (the extra points reach the taken ones); copper level 4; min 3.
    expect(splitIncLevel(3, 8, 2).level).toBe(3);
    expect(m.speedOverride).toBe(17500); // 1 + accTable[3] / 1000
    expect(m.served(MAGNET)).toBe(1);
  });
});

describe('MachineSim power', () => {
  const def = fixtureData.building(ASM_MK2)!;

  it('demands work power while replicating and idle power otherwise', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear);
    expect(m.powerDemand()).toBe(def.power.idlePerTick);
    serve(m, INGOT, 1);
    m.tick(1);
    expect(m.powerDemand()).toBe(def.power.workPerTick);
    for (let t = 0; t < 70; t++) m.tick(1); // the single craft finishes, nothing left to start
    expect(m.powerDemand()).toBe(def.power.idlePerTick);
  });

  it('raises work power by the power table of the level: x2.5 at Mk.III', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear);
    serve(m, INGOT, 1, 4);
    m.tick(1);
    expect(m.powerDemand()).toBe((def.power.workPerTick * 2500) / 1000);
  });

  it('draws idle power while blocked, even with a high level', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear);
    run(m, 2000, { drain: false, incPerItem: 4 });
    expect(m.state).toBe('blocked');
    expect(m.powerDemand()).toBe(def.power.idlePerTick);
  });
});

describe('MachineSim sorter interface', () => {
  it('offers products only, one item per pick, honouring the filter and the accept test', () => {
    const m = machineOf(REFINERY, RECIPE.refine);
    for (let t = 0; t < 600; t++) {
      for (const item of m.ingredientItems()) if (m.needs(item)) m.insert(item, 1, 0);
      m.tick(1);
    }
    expect(m.pickProduct(CRUDE, () => true)).toBeNull(); // never an ingredient
    expect(m.pickProduct(GEAR, () => true)).toBeNull();
    expect(m.pickProduct(HYDROGEN, (item) => item !== HYDROGEN)).toBeNull();
    const before = m.produced(REFINED_OIL);
    expect(m.pickProduct(REFINED_OIL, () => true)).toEqual({ item: REFINED_OIL, count: 1, inc: 0 });
    expect(m.produced(REFINED_OIL)).toBe(before - 1);
    // No filter: the first product that is accepted.
    expect(m.pickProduct(0, (item) => item === REFINED_OIL)?.item).toBe(REFINED_OIL);
    expect(m.pickProduct(0, () => true)?.item).toBe(HYDROGEN);
  });

  it('refuses an item that is not an ingredient', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear);
    expect(m.insert(ORE, 1, 0)).toBe(false);
    expect(m.served(ORE)).toBe(0);
  });

  it('keeps accepting items past the threshold: only needs() holds sorters back', () => {
    const m = machineOf(ASM_MK2, RECIPE.gear);
    serve(m, INGOT, 4);
    expect(m.needs(INGOT)).toBe(false);
    expect(m.insert(INGOT, 4, 0)).toBe(true);
    expect(m.served(INGOT)).toBe(8);
  });
});

describe('MachineSim labs (matrix production)', () => {
  it('wants 6 items of each ingredient in a Matrix Lab, 12 in a Self-evolution Lab', () => {
    const lab = machineOf(MATRIX_LAB, RECIPE.matrix);
    serve(lab, COIL, 5);
    expect(lab.needs(COIL)).toBe(true);
    serve(lab, COIL, 1);
    expect(lab.needs(COIL)).toBe(false);
    expect(lab.needs(1301)).toBe(true);
    expect(lab.needsAny()).toBe(true);
    serve(lab, 1301, 6);
    expect(lab.needsAny()).toBe(false);

    const evo = machineOf(EVOLUTION_LAB, RECIPE.matrix);
    serve(evo, COIL, 11);
    expect(evo.needs(COIL)).toBe(true);
    serve(evo, COIL, 1);
    expect(evo.needs(COIL)).toBe(false);
  });

  it('wants only 6 for a recipe longer than 540 ticks, even in a Self-evolution Lab', () => {
    const evo = machineOf(EVOLUTION_LAB, RECIPE.gravity);
    serve(evo, 1209, 5);
    expect(evo.needs(1209)).toBe(true);
    serve(evo, 1209, 1);
    expect(evo.needs(1209)).toBe(false);
  });

  it('makes a matrix every 3 s at 1x and stops at 10 buffered', () => {
    const lab = machineOf(MATRIX_LAB, RECIPE.matrix);
    run(lab, 180 * 4 + 1, { drain: false });
    expect(lab.crafts).toBe(4);
    run(lab, 180 * 20, { drain: false });
    expect(lab.produced(6001)).toBe(10);
    expect(lab.state).toBe('blocked');
    expect(lab.powerDemand()).toBe(fixtureData.building(MATRIX_LAB)!.power.idlePerTick);
  });

  it('a Self-evolution Lab is 3x as fast and buffers 30', () => {
    const lab = machineOf(EVOLUTION_LAB, RECIPE.matrix);
    run(lab, 180 * 3 + 1, { drain: false });
    expect(lab.crafts).toBe(9);
    run(lab, 180 * 20, { drain: false });
    expect(lab.produced(6001)).toBe(30);
  });

  it('takes extra products from a proliferated matrix recipe', () => {
    const lab = machineOf(MATRIX_LAB, RECIPE.matrix, 0);
    const out = run(lab, 180 * 400 + 5, { incPerItem: 4 });
    expect(Math.abs((out.get(6001) ?? 0) - 500)).toBeLessThanOrEqual(1);
  });
});

describe('machineConfig', () => {
  it('reads speed, power and tables from GameData', () => {
    const cfg = configOf(ASM_MK3, RECIPE.coil, 1);
    expect(cfg.speed).toBe(15000);
    expect(cfg.workPerTick).toBe(fixtureData.building(ASM_MK3)!.power.workPerTick);
    expect(cfg.mode).toBe(1);
    expect(cfg.productive).toBe(true);
    expect(cfg.lab).toBe(false);
    expect(configOf(REFINERY, RECIPE.xray).productive).toBe(false);
    const lab = configOf(MATRIX_LAB, RECIPE.matrix);
    expect(lab.lab).toBe(true);
    expect(lab.speed).toBe(10000);
  });

  it('rejects a building that makes nothing', () => {
    const belt = fixtureData.building(ITEM.belt[1])!;
    expect(() => machineConfig(belt, fixtureData.recipe(RECIPE.gear), fixtureData, 0)).toThrow(/Conveyor/);
  });
});
