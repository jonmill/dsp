import { describe, expect, test } from 'vitest';
import type { TechEffects } from '../data';
import type { BeltPath, Layout, PlacedBuilding, Sorter } from '../geometry';
import { beltCapacity, beltStack, checkCapacity, sorterRate } from './capacity';
import {
  codesOf,
  compositeLayout,
  fixtureData,
  fixtureEffects,
  ITEM,
  LayoutKit,
  line,
  onNode,
  onSlot,
  only,
  patchBuilding,
  planOf,
  planStage,
} from './testkit';
import type { Violation } from './types';

const IRON_ORE = 1001;
const IRON_INGOT = 1101;
const MAGNET = 1102;
const COPPER_INGOT = 1104;
const RECIPE_IRON_INGOT = 1;
const RECIPE_GEAR = 5; // 1 Iron Ingot -> 1 Gear
const RECIPE_COIL = 6; // 2 Magnet + 1 Copper Ingot -> 2 Magnetic Coil

const effectsWith = (over: Partial<TechEffects>): TechEffects => ({ ...fixtureEffects, ...over });

describe('beltCapacity', () => {
  test('Mk.I at stack 1 carries 6/s, Mk.II 12/s and Mk.III 30/s', () => {
    expect(beltCapacity(ITEM.belt[1], 1, fixtureData)).toBe(6);
    expect(beltCapacity(ITEM.belt[2], 1, fixtureData)).toBe(12);
    expect(beltCapacity(ITEM.belt[3], 1, fixtureData)).toBe(30);
  });

  test('stacking multiplies it: Mk.III at stack 4 carries 120/s, Mk.I at stack 2 carries 12/s', () => {
    expect(beltCapacity(ITEM.belt[3], 4, fixtureData)).toBe(120);
    expect(beltCapacity(ITEM.belt[1], 2, fixtureData)).toBe(12);
  });

  test('reads the belt speed from GameData, not from a table of its own', () => {
    const data = patchBuilding(fixtureData, ITEM.belt[1], (b) => ({ ...b, belt: { speed: 3 } }));
    expect(beltCapacity(ITEM.belt[1], 1, data)).toBe(18);
  });

  test('an item that is not a belt is a loud error', () => {
    expect(() => beltCapacity(ITEM.sorter.mk1, 1, fixtureData)).toThrow(/no belt.*2011/);
    expect(() => beltCapacity(9999, 1, fixtureData)).toThrow(/no belt.*9999/);
  });
});

describe('beltStack', () => {
  const belt = (over: Partial<BeltPath>): BeltPath => ({
    id: 1,
    tierItemId: 2001,
    itemId: IRON_ORE,
    nodes: [],
    plannedRate: 1,
    ...over,
  });

  test('a belt that leaves a station port carries the tech-level station stack', () => {
    const stacked = effectsWith({ stationPilerLevel: 4 });
    expect(beltStack(belt({ source: { buildingId: 1, port: 0 } }), stacked)).toBe(4);
    expect(beltStack(belt({ source: { buildingId: 1, port: 0 } }), fixtureEffects)).toBe(1);
  });

  test('any other belt (fed by a sorter or another belt) is stack 1', () => {
    expect(beltStack(belt({}), effectsWith({ stationPilerLevel: 4 }))).toBe(1);
    expect(beltStack(belt({ sink: { kind: 'belt', beltId: 2, node: 0 } }), effectsWith({ stationPilerLevel: 4 }))).toBe(1);
  });
});

describe('sorterRate', () => {
  test('Mk.I: 1.5/s at span 1, 0.75/s at span 2, 0.5/s at span 3', () => {
    expect(sorterRate(ITEM.sorter.mk1, 1, 1, fixtureEffects, fixtureData)).toBeCloseTo(1.5, 12);
    expect(sorterRate(ITEM.sorter.mk1, 2, 1, fixtureEffects, fixtureData)).toBeCloseTo(0.75, 12);
    expect(sorterRate(ITEM.sorter.mk1, 3, 1, fixtureEffects, fixtureData)).toBeCloseTo(0.5, 12);
  });

  test('Mk.II is 3/s and Mk.III is 6/s at span 1', () => {
    expect(sorterRate(ITEM.sorter.mk2, 1, 1, fixtureEffects, fixtureData)).toBeCloseTo(3, 12);
    expect(sorterRate(ITEM.sorter.mk3, 1, 1, fixtureEffects, fixtureData)).toBeCloseTo(6, 12);
  });

  test('a non-pile sorter moves the whole stack of the belt it picks from: Mk.III on a 4-stack belt is 24/s', () => {
    expect(sorterRate(ITEM.sorter.mk3, 1, 4, fixtureEffects, fixtureData)).toBeCloseTo(24, 12);
    expect(sorterRate(ITEM.sorter.mk1, 1, 2, fixtureEffects, fixtureData)).toBeCloseTo(3, 12);
  });

  test('stt is floored at 10000 (one tick per leg) before the span multiplies in', () => {
    // stt 5000 x span 1 = 5000, floored to 10000: a 2-tick round trip is 30/s.
    const data = patchBuilding(fixtureData, ITEM.sorter.mk3, (b) => ({
      ...b,
      sorter: { ...b.sorter!, stt: 5000 },
    }));
    expect(sorterRate(ITEM.sorter.mk3, 1, 1, fixtureEffects, data)).toBeCloseTo(30, 12);
    // At span 3 it is 15000, above the floor: a 3-tick round trip is 20/s.
    expect(sorterRate(ITEM.sorter.mk3, 3, 1, fixtureEffects, data)).toBeCloseTo(20, 12);
  });

  test('a pile sorter slows with span like any sorter and moves min(inserterStackInput, 4) items per trip from a belt', () => {
    // stt 30000 -> 6 ticks per round trip at span 1 -> 10 trips/s, x2 items (base inserterStackInput).
    expect(sorterRate(ITEM.sorter.pile, 1, 1, fixtureEffects, fixtureData)).toBeCloseTo(20, 12);
    // Span 2: stt 60000, 12 ticks, 5 trips/s. Span 3: stt 90000, 18 ticks, 10/3 trips/s (ruling: conservative).
    expect(sorterRate(ITEM.sorter.pile, 2, 1, fixtureEffects, fixtureData)).toBeCloseTo(10, 12);
    expect(sorterRate(ITEM.sorter.pile, 3, 1, fixtureEffects, fixtureData)).toBeCloseTo(20 / 3, 12);
    expect(sorterRate(ITEM.sorter.pile, 1, 4, fixtureEffects, fixtureData)).toBeCloseTo(20, 12);
    expect(sorterRate(ITEM.sorter.pile, 1, 1, effectsWith({ inserterStackInput: 3 }), fixtureData)).toBeCloseTo(30, 12);
    expect(sorterRate(ITEM.sorter.pile, 1, 1, effectsWith({ inserterStackInput: 6 }), fixtureData)).toBeCloseTo(40, 12);
  });

  test('picking from a building moves one item per trip, pile sorter included (stackFromBelt 0)', () => {
    expect(sorterRate(ITEM.sorter.pile, 1, 0, fixtureEffects, fixtureData)).toBeCloseTo(10, 12);
    expect(sorterRate(ITEM.sorter.pile, 3, 0, fixtureEffects, fixtureData)).toBeCloseTo(10 / 3, 12);
    expect(sorterRate(ITEM.sorter.mk3, 1, 0, fixtureEffects, fixtureData)).toBeCloseTo(6, 12);
  });

  test('an item that is not a sorter is a loud error', () => {
    expect(() => sorterRate(ITEM.belt[1], 1, 1, fixtureEffects, fixtureData)).toThrow(/no sorter.*2001/);
    expect(() => sorterRate(9999, 1, 1, fixtureEffects, fixtureData)).toThrow(/no sorter.*9999/);
  });
});

describe('RATE_BELT', () => {
  /** One station with a belt of `tier` leaving port 0, planned at `rate`. */
  const stationBelt = (tier: 1 | 2 | 3, rate: number, plain = false) => {
    const kit = new LayoutKit();
    const station = kit.station(0, 0);
    const belt = kit.belt(tier, IRON_ORE, line([1, 4], [8, 4]), {
      plannedRate: rate,
      ...(plain ? {} : { source: { buildingId: station.id, port: 0 } }),
    });
    return { kit, belt };
  };
  const check = (kit: LayoutKit, effects: TechEffects = fixtureEffects): Violation[] =>
    checkCapacity(kit.layout(), planOf([]), kit.data, effects);

  test('a belt planned within its capacity passes, one over it fails and names the belt', () => {
    const ok = stationBelt(1, 6);
    expect(check(ok.kit)).toEqual([]);

    const over = stationBelt(1, 6.5);
    const violations = check(over.kit);
    expect(codesOf(violations)).toEqual(['RATE_BELT']);
    expect(violations[0].entities).toEqual([{ kind: 'belt', id: over.belt.id }]);
    expect(violations[0].message).toMatch(new RegExp(`belt ${over.belt.id}\\b.*6\\.5.*6`));
  });

  test('a station-sourced belt carries stationPilerLevel stacks', () => {
    // Mk.III at stack 4 carries 120/s; Mk.I at stack 2 carries 12/s.
    expect(check(stationBelt(3, 100).kit, effectsWith({ stationPilerLevel: 4 }))).toEqual([]);
    expect(codesOf(check(stationBelt(3, 100).kit, fixtureEffects))).toEqual(['RATE_BELT']);
    expect(check(stationBelt(1, 11).kit, effectsWith({ stationPilerLevel: 2 }))).toEqual([]);
    expect(codesOf(check(stationBelt(1, 13).kit, effectsWith({ stationPilerLevel: 2 })))).toEqual(['RATE_BELT']);
  });

  test('a belt that does not start at a station inherits no stack, whatever the tech level', () => {
    const { kit } = stationBelt(1, 7, true);
    expect(codesOf(check(kit, effectsWith({ stationPilerLevel: 4 })))).toEqual(['RATE_BELT']);
  });

  test('rounding noise at exactly the capacity does not fail', () => {
    expect(check(stationBelt(1, 6 * (1 + 1e-12)).kit)).toEqual([]);
    expect(check(stationBelt(2, 12).kit)).toEqual([]);
  });
});

describe('RATE_SORTER', () => {
  /** A sorter of `tier` and `span` between two machines (building pick) or from a belt, planned at `rate`. */
  const lone = (
    pick: 'building' | 'station-belt' | 'plain-belt',
    tier: Sorter['tierItemId'],
    span: 1 | 2 | 3,
    rate: number,
  ) => {
    const kit = new LayoutKit();
    const a = kit.assembler(6, 8);
    const b = kit.assembler(10, 8);
    const station = kit.station(0, 0);
    const belt = kit.belt(3, IRON_ORE, line([1, 4], [8, 4]), {
      plannedRate: 0,
      ...(pick === 'station-belt' ? { source: { buildingId: station.id, port: 0 } } : {}),
    });
    const sorter = kit.sorter(pick === 'building' ? onSlot(a, 4) : onNode(belt, 3), onSlot(b, 10), span, {
      tierItemId: tier,
      plannedRate: rate,
    });
    return { kit, sorter };
  };
  const check = (kit: LayoutKit, effects: TechEffects = fixtureEffects): Violation[] =>
    only(checkCapacity(kit.layout(), planOf([]), kit.data, effects), 'RATE_SORTER');

  test('Mk.I picking from a building: 1.5/s at span 1 passes, 1.6/s fails and names the sorter', () => {
    expect(check(lone('building', ITEM.sorter.mk1, 1, 1.5).kit)).toEqual([]);
    const over = lone('building', ITEM.sorter.mk1, 1, 1.6);
    const violations = check(over.kit);
    expect(codesOf(violations)).toEqual(['RATE_SORTER']);
    expect(violations[0].entities).toEqual([{ kind: 'sorter', id: over.sorter.id }]);
    expect(violations[0].message).toMatch(new RegExp(`sorter ${over.sorter.id}\\b.*1\\.6.*1\\.5`));
  });

  test('span slows the sorter: 0.5/s at span 3', () => {
    expect(check(lone('building', ITEM.sorter.mk1, 3, 0.5).kit)).toEqual([]);
    expect(codesOf(check(lone('building', ITEM.sorter.mk1, 3, 0.6).kit))).toEqual(['RATE_SORTER']);
  });

  test('a non-pile sorter picking from a stacked station belt moves the whole stack', () => {
    const stacked = effectsWith({ stationPilerLevel: 4 });
    // Mk.III on a 4-stack belt: 24/s.
    expect(check(lone('station-belt', ITEM.sorter.mk3, 1, 24).kit, stacked)).toEqual([]);
    expect(codesOf(check(lone('station-belt', ITEM.sorter.mk3, 1, 25).kit, stacked))).toEqual(['RATE_SORTER']);
    // The same sorter on a belt that is not station-sourced sees stack 1: 6/s.
    expect(check(lone('plain-belt', ITEM.sorter.mk3, 1, 6).kit, stacked)).toEqual([]);
    expect(codesOf(check(lone('plain-belt', ITEM.sorter.mk3, 1, 7).kit, stacked))).toEqual(['RATE_SORTER']);
  });

  test('a pile sorter from a belt moves min(inserterStackInput, 4) per trip; from a building one; span slows it', () => {
    expect(check(lone('plain-belt', ITEM.sorter.pile, 1, 20).kit)).toEqual([]);
    expect(codesOf(check(lone('plain-belt', ITEM.sorter.pile, 1, 21).kit))).toEqual(['RATE_SORTER']);
    expect(check(lone('plain-belt', ITEM.sorter.pile, 2, 10).kit)).toEqual([]);
    expect(codesOf(check(lone('plain-belt', ITEM.sorter.pile, 2, 11).kit))).toEqual(['RATE_SORTER']);
    // inserterStackInput 5 is capped at a cargo of 4: span 2 gives 5 trips/s x 4 items.
    expect(check(lone('plain-belt', ITEM.sorter.pile, 2, 20).kit, effectsWith({ inserterStackInput: 5 }))).toEqual([]);
    expect(
      codesOf(check(lone('plain-belt', ITEM.sorter.pile, 2, 21).kit, effectsWith({ inserterStackInput: 5 }))),
    ).toEqual(['RATE_SORTER']);
    expect(check(lone('building', ITEM.sorter.pile, 1, 10).kit)).toEqual([]);
    expect(codesOf(check(lone('building', ITEM.sorter.pile, 1, 11).kit))).toEqual(['RATE_SORTER']);
    expect(check(lone('building', ITEM.sorter.pile, 2, 5).kit)).toEqual([]);
    expect(codesOf(check(lone('building', ITEM.sorter.pile, 2, 6).kit))).toEqual(['RATE_SORTER']);
  });

  test('a sorter that picks from a belt the layout does not contain is judged at stack 1, not thrown on', () => {
    const { kit, sorter } = lone('plain-belt', ITEM.sorter.mk3, 1, 7);
    sorter.pick = { kind: 'belt', beltId: 999, node: 0 };
    expect(codesOf(check(kit))).toEqual(['RATE_SORTER']);
  });
});

describe('RATE_MACHINE_INPUT', () => {
  const GEAR_NEEDS_2 = planOf([planStage(RECIPE_GEAR, { inputs: [{ itemId: IRON_INGOT, perSecond: 2 }] })]);

  /** An assembler on the Gear recipe with an iron-ingot belt beside it. */
  const gearCell = () => {
    const kit = new LayoutKit();
    const asm = kit.assembler(6, 8, 0, RECIPE_GEAR);
    const belt = kit.belt(3, IRON_INGOT, line([0, 6], [12, 6]));
    return { kit, asm, belt };
  };
  const run = (kit: LayoutKit, plan = GEAR_NEEDS_2, effects: TechEffects = fixtureEffects): Violation[] =>
    checkCapacity(kit.layout(), plan, kit.data, effects);
  const machineInput = (kit: LayoutKit, plan = GEAR_NEEDS_2) => only(run(kit, plan), 'RATE_MACHINE_INPUT');

  test('an assembler fed by one Mk.I sorter for a 2/s ingredient fails', () => {
    const { kit, asm, belt } = gearCell();
    const feed = kit.sorter(onNode(belt, 6), onSlot(asm, 7), 1, { plannedRate: 1.5 });
    const violations = run(kit);
    expect(codesOf(violations)).toEqual(['RATE_MACHINE_INPUT']);
    expect(violations[0].entities).toEqual([
      { kind: 'building', id: asm.id },
      { kind: 'sorter', id: feed.id },
    ]);
    expect(violations[0].message).toMatch(new RegExp(`building ${asm.id}\\b`));
    expect(violations[0].message).toMatch(/Iron Ingot/);
    expect(violations[0].message).toMatch(/1\.5\/s/);
    expect(violations[0].message).toMatch(/2\/s/);
  });

  test('the same assembler fed by two Mk.III sorters passes', () => {
    const { kit, asm, belt } = gearCell();
    for (const node of [5, 7]) {
      kit.sorter(onNode(belt, node), onSlot(asm, 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1 });
    }
    expect(run(kit)).toEqual([]);
  });

  test('the supply must reach 99.9 % of the planned rate, not just be close', () => {
    const { kit, asm, belt } = gearCell();
    const feed = kit.sorter(onNode(belt, 6), onSlot(asm, 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1.9981 });
    expect(machineInput(kit)).toEqual([]);
    feed.plannedRate = 1.99;
    expect(codesOf(machineInput(kit))).toEqual(['RATE_MACHINE_INPUT']);
  });

  test('a supply that equals the 0.999 threshold up to rounding noise passes', () => {
    const { kit, asm, belt } = gearCell();
    kit.sorter(onNode(belt, 6), onSlot(asm, 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 2 * 0.999 * (1 - 1e-12) });
    expect(machineInput(kit)).toEqual([]);
  });

  test('the requirement is the planned rate per machine (stage total over machines), not full speed', () => {
    const { kit, asm, belt } = gearCell();
    // 3/s over 2 machines: 1.5/s each, though a Mk.I assembler at full speed would take more.
    const plan = planOf([
      planStage(RECIPE_GEAR, { machines: 2, exactMachines: 1.5, utilization: 0.75, inputs: [{ itemId: IRON_INGOT, perSecond: 3 }] }),
    ]);
    const feed = kit.sorter(onNode(belt, 6), onSlot(asm, 7), 1, { plannedRate: 1.5 });
    expect(machineInput(kit, plan)).toEqual([]);
    feed.plannedRate = 1.4;
    expect(codesOf(machineInput(kit, plan))).toEqual(['RATE_MACHINE_INPUT']);
  });

  test('an ingredient nothing feeds fails, naming only the machine', () => {
    const { kit, asm } = gearCell();
    const violations = machineInput(kit);
    expect(violations).toHaveLength(1);
    expect(violations[0].entities).toEqual([{ kind: 'building', id: asm.id }]);
    expect(violations[0].message).toMatch(/Iron Ingot/);
    expect(violations[0].message).toMatch(/\b0\/s/);
  });

  test('every ingredient is checked on its own; one violation for each short one', () => {
    const kit = new LayoutKit();
    const asm = kit.assembler(6, 8, 0, RECIPE_COIL);
    const magnets = kit.belt(3, MAGNET, line([0, 6], [12, 6]));
    const copper = kit.belt(3, COPPER_INGOT, line([0, 4], [12, 4]));
    const plan = planOf([
      planStage(RECIPE_COIL, {
        inputs: [
          { itemId: MAGNET, perSecond: 2 },
          { itemId: COPPER_INGOT, perSecond: 1 },
        ],
      }),
    ]);
    kit.sorter(onNode(magnets, 6), onSlot(asm, 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 2 });
    const short = machineInput(kit, plan);
    expect(short).toHaveLength(1);
    expect(short[0].message).toMatch(/Copper Ingot/);

    kit.sorter(onNode(copper, 6), onSlot(asm, 3), 1, { plannedRate: 1 });
    expect(machineInput(kit, plan)).toEqual([]);
  });

  describe('which sorters count toward an ingredient', () => {
    test('a sorter filtered to the ingredient counts, wherever it picks from', () => {
      const kit = new LayoutKit();
      const asm = kit.assembler(6, 8, 0, RECIPE_GEAR);
      const upstream = kit.assembler(10, 8, 0, RECIPE_IRON_INGOT);
      kit.sorter(onSlot(upstream, 6), onSlot(asm, 10), 1, { tierItemId: ITEM.sorter.mk3, filterItemId: IRON_INGOT, plannedRate: 2 });
      expect(machineInput(kit)).toEqual([]);
    });

    test('a sorter filtered to another item does not count', () => {
      const { kit, asm, belt } = gearCell();
      kit.sorter(onNode(belt, 6), onSlot(asm, 7), 1, { tierItemId: ITEM.sorter.mk3, filterItemId: MAGNET, plannedRate: 2 });
      expect(codesOf(machineInput(kit))).toEqual(['RATE_MACHINE_INPUT']);
    });

    test('an unfiltered sorter counts only if its belt carries the ingredient', () => {
      const { kit, asm } = gearCell();
      const wrong = kit.belt(3, MAGNET, line([0, 2], [12, 2]));
      kit.sorter(onNode(wrong, 6), onSlot(asm, 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 2 });
      expect(codesOf(machineInput(kit))).toEqual(['RATE_MACHINE_INPUT']);
    });

    test('an unfiltered sorter picking from a building counts toward nothing', () => {
      const kit = new LayoutKit();
      const asm = kit.assembler(6, 8, 0, RECIPE_GEAR);
      const upstream = kit.assembler(10, 8, 0, RECIPE_IRON_INGOT);
      kit.sorter(onSlot(upstream, 6), onSlot(asm, 10), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 2 });
      expect(codesOf(machineInput(kit))).toEqual(['RATE_MACHINE_INPUT']);
    });

    test('sorters into another machine, or out of this one, do not count', () => {
      const { kit, asm, belt } = gearCell();
      const other = kit.assembler(10, 8, 0, RECIPE_GEAR);
      kit.sorter(onNode(belt, 6), onSlot(other, 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 2 });
      kit.sorter(onSlot(asm, 6), onNode(belt, 8), 1, { tierItemId: ITEM.sorter.mk3, filterItemId: IRON_INGOT, plannedRate: 2 });
      // `asm` gets nothing; `other` is also a Gear machine and takes the plan's single stage as well.
      const violations = machineInput(kit);
      expect(violations.map((v) => v.entities[0])).toEqual([{ kind: 'building', id: asm.id }]);
    });

    test('the rates of several sorters add up', () => {
      const { kit, asm, belt } = gearCell();
      for (const node of [4, 5, 6, 7]) kit.sorter(onNode(belt, node), onSlot(asm, 7), 1, { plannedRate: 0.5 });
      expect(machineInput(kit)).toEqual([]);
      kit.sorters[3].plannedRate = 0.4;
      expect(codesOf(machineInput(kit))).toEqual(['RATE_MACHINE_INPUT']);
    });
  });

  describe('which stage a machine belongs to', () => {
    const twoGearStages = planOf([
      planStage(RECIPE_GEAR, { inputs: [{ itemId: IRON_INGOT, perSecond: 1 }] }),
      planStage(RECIPE_GEAR, { inputs: [{ itemId: IRON_INGOT, perSecond: 4 }] }),
    ]);

    test('with no role the first stage with the machine recipe applies', () => {
      const { kit, asm, belt } = gearCell();
      kit.sorter(onNode(belt, 6), onSlot(asm, 7), 1, { plannedRate: 1 });
      expect(machineInput(kit, twoGearStages)).toEqual([]);
    });

    test('a stage:<index> role selects that stage over the recipe match', () => {
      const { kit, asm, belt } = gearCell();
      asm.role = 'stage:1';
      kit.sorter(onNode(belt, 6), onSlot(asm, 7), 1, { plannedRate: 1 });
      const violations = machineInput(kit, twoGearStages);
      expect(codesOf(violations)).toEqual(['RATE_MACHINE_INPUT']);
      expect(violations[0].message).toMatch(/\b4\b/);
    });

    test('a role works without a recipeId on the building', () => {
      const { kit, belt } = gearCell();
      const bare: PlacedBuilding = kit.building(ITEM.assembler, 10, 8, 0, { role: 'stage:0' });
      kit.sorter(onNode(belt, 6), onSlot(bare, 7), 1, { plannedRate: 1 });
      const short = (): number[] => machineInput(kit, twoGearStages).map((v) => v.entities[0].id);
      // Stage 0 needs 1/s per machine: met. (The recipe-matched assembler of gearCell() is unfed.)
      expect(short()).not.toContain(bare.id);
      bare.role = 'stage:1'; // 4/s per machine: not met.
      expect(short()).toContain(bare.id);
    });

    test('a role that is not a valid stage tag falls back to the recipe', () => {
      for (const role of ['feeder', 'stage:', 'stage:7', 'stage:-1']) {
        const { kit, asm, belt } = gearCell();
        asm.role = role;
        kit.sorter(onNode(belt, 6), onSlot(asm, 7), 1, { plannedRate: 1 });
        expect(machineInput(kit, twoGearStages)).toEqual([]);
      }
    });

    test('machines the plan does not describe, and stages with no machines, are skipped', () => {
      const { kit } = gearCell();
      kit.assembler(10, 8, 0, 6); // recipe 6 is not in the plan
      kit.building(ITEM.assembler, 14, 8); // no recipe, no role
      kit.station(20, 0);
      expect(machineInput(kit)).toHaveLength(1); // only the Gear assembler of gearCell()
      const none = planOf([planStage(RECIPE_GEAR, { machines: 0, inputs: [{ itemId: IRON_INGOT, perSecond: 2 }] })]);
      expect(machineInput(kit, none)).toEqual([]);
    });
  });
});

describe('RATE_MACHINE_INPUT: a lab stack is one machine (MX §4.4)', () => {
  const RECIPE_EM_MATRIX = 9; // 1 Magnetic Coil + 1 Circuit Board -> 1 Electromagnetic Matrix, 3 s
  const COIL = 1202;
  const BOARD = 1301;
  // 6 labs share the stage; each takes 1/3 per second of each ingredient
  const plan = planOf([
    planStage(RECIPE_EM_MATRIX, {
      buildingItemId: ITEM.matrixLab,
      machines: 6,
      exactMachines: 6,
      inputs: [
        { itemId: COIL, perSecond: 2 },
        { itemId: BOARD, perSecond: 2 },
      ],
    }),
  ]);

  /** A stack of `count` labs with a coil and a board belt beside the bottom one. */
  function stack(count: number) {
    const kit = new LayoutKit();
    const labs: PlacedBuilding[] = [];
    for (let i = 0; i < count; i++) {
      labs.push(
        kit.building(ITEM.matrixLab, 20, 8, 0, {
          recipeId: RECIPE_EM_MATRIX,
          role: 'stage:0',
          z: 3 * i,
          ...(i > 0 ? { stackParentId: labs[i - 1].id } : {}),
        }),
      );
    }
    const coil = kit.belt(3, COIL, line([0, 6], [30, 6]));
    const board = kit.belt(3, BOARD, line([0, 4], [30, 4]));
    return { kit, labs, coil, board };
  }
  const input = (kit: LayoutKit): Violation[] => only(checkCapacity(kit.layout(), plan, kit.data, fixtureEffects), 'RATE_MACHINE_INPUT');

  test('a stack of 3 needs 3 labs of each ingredient from the sorters of its bottom lab', () => {
    const { kit, labs, coil, board } = stack(3);
    kit.sorter(onNode(coil, 20), onSlot(labs[0], 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1, filterItemId: COIL });
    kit.sorter(onNode(board, 20), onSlot(labs[0], 8), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1, filterItemId: BOARD });
    expect(input(kit)).toEqual([]);
  });

  test('fails when the bottom lab gets only its own share, naming the bottom lab and the stack total', () => {
    const { kit, labs, coil, board } = stack(3);
    kit.sorter(onNode(coil, 20), onSlot(labs[0], 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1 / 3, filterItemId: COIL });
    kit.sorter(onNode(board, 20), onSlot(labs[0], 8), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1, filterItemId: BOARD });
    const v = input(kit);
    expect(v).toHaveLength(1);
    expect(v[0].entities[0]).toEqual({ kind: 'building', id: labs[0].id });
    expect(v[0].message).toMatch(/Magnetic Coil/);
    expect(v[0].message).toMatch(/stack of 3/);
    expect(v[0].message).toMatch(/needs 1\/s/);
  });

  test('the stacked labs themselves are not judged on their own (they take no sorters)', () => {
    const { kit, labs, coil, board } = stack(3);
    kit.sorter(onNode(coil, 20), onSlot(labs[0], 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1, filterItemId: COIL });
    kit.sorter(onNode(board, 20), onSlot(labs[0], 8), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1, filterItemId: BOARD });
    expect(input(kit).filter((x) => x.entities.some((e) => e.id === labs[1].id || e.id === labs[2].id))).toEqual([]);
  });

  test('a lone lab (no stack) is judged as before: it needs only its own share', () => {
    const { kit, labs, coil, board } = stack(1);
    kit.sorter(onNode(coil, 20), onSlot(labs[0], 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1 / 3, filterItemId: COIL });
    kit.sorter(onNode(board, 20), onSlot(labs[0], 8), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1 / 3, filterItemId: BOARD });
    expect(input(kit)).toEqual([]);
  });
});

describe('checkCapacity as a whole', () => {
  test('the composite layout, planned at half a Mk.I belt, passes', () => {
    const c = compositeLayout();
    // Both assemblers run recipe 1 (1 Iron Ore -> 1 Iron Ingot) at 0.5 ore/s each; feeds are planned at 1/s.
    const plan = planOf([planStage(RECIPE_IRON_INGOT, { machines: 2, inputs: [{ itemId: IRON_ORE, perSecond: 1 }] })]);
    expect(checkCapacity(c.kit.layout(), plan, c.kit.data, c.kit.effects)).toEqual([]);
  });

  test('violations come grouped by rule: belts, then sorters, then machine inputs', () => {
    const c = compositeLayout();
    c.belt.plannedRate = 10; // station-sourced Mk.I: capacity 6
    c.link.plannedRate = 2; // Mk.I building to building: 1.5
    const plan = planOf([planStage(RECIPE_IRON_INGOT, { machines: 2, inputs: [{ itemId: IRON_ORE, perSecond: 8 }] })]);
    const codes = codesOf(checkCapacity(c.kit.layout(), plan, c.kit.data, c.kit.effects));
    expect(codes).toEqual(['RATE_BELT', 'RATE_SORTER', 'RATE_MACHINE_INPUT', 'RATE_MACHINE_INPUT']);
  });

  test('an empty layout has nothing to violate', () => {
    const layout: Layout = new LayoutKit().layout();
    expect(checkCapacity(layout, planOf([]), fixtureData, fixtureEffects)).toEqual([]);
  });

  test('stays linear: a layout of 20 000 machines and 40 000 sorters is checked in well under a second', () => {
    const kit = new LayoutKit();
    const belt = kit.belt(3, IRON_INGOT, line([0, 0], [40, 0]), { plannedRate: 1 });
    for (let i = 0; i < 20_000; i++) {
      const asm = kit.assembler(i * 4, 20, 0, RECIPE_GEAR);
      kit.sorter(onNode(belt, i % 40), onSlot(asm, 7), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1 });
      kit.sorter(onNode(belt, (i + 1) % 40), onSlot(asm, 6), 1, { tierItemId: ITEM.sorter.mk3, plannedRate: 1 });
    }
    const plan = planOf([planStage(RECIPE_GEAR, { machines: 20_000, inputs: [{ itemId: IRON_INGOT, perSecond: 40_000 }] })]);
    const layout = kit.layout();
    const start = performance.now();
    const violations = checkCapacity(layout, plan, kit.data, kit.effects);
    const elapsed = performance.now() - start;
    expect(violations).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });
});
