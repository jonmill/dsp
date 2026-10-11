import { describe, expect, it } from 'vitest';
import { fixtureData, fixtureEffects, ITEM } from '../testkit';
import { BeltSim } from './belt';
import type { Cargo } from './cargo';
import { SorterSim, sorterSettings } from './sorter';
import type { BeltRef, InsertTarget, PickSource, SorterConfig } from './sorter';

const ORE = 1001;
const WARMUP = 120;
const MEASURE = 3000; // 50 s: long enough that a one-tick wobble per trip would show

/** A target with a switchable appetite that records what it is given. */
class FakeTarget implements InsertTarget {
  needing = true;
  /** When set, only this item is needed. */
  only: number | null = null;
  accepting = true;
  items = 0;
  inc = 0;
  readonly calls: { item: number; count: number; inc: number }[] = [];
  constructor(readonly careNeeds = true) {}
  needs(item: number): boolean {
    return this.needing && (this.only === null || item === this.only);
  }
  insert(item: number, count: number, inc: number): boolean {
    if (!this.accepting) return false;
    this.calls.push({ item, count, inc });
    this.items += count;
    this.inc += inc;
    return true;
  }
}

/** A building output with `left` single products (or stacks of `stack`) to give away. */
class Supply implements PickSource {
  pickCalls = 0;
  firstPickCallTick = -1;
  lastAccept: ((item: number) => boolean) | null = null;
  tick = 0;
  constructor(
    public left = Infinity,
    readonly item = ORE,
    readonly stack = 1,
    readonly inc = 0,
  ) {}
  pickProduct(filter: number, accept: (item: number) => boolean) {
    this.pickCalls++;
    if (this.firstPickCallTick < 0) this.firstPickCallTick = this.tick;
    this.lastAccept = accept;
    if (this.left <= 0 || (filter !== 0 && filter !== this.item) || !accept(this.item)) return null;
    this.left--;
    return { item: this.item, count: this.stack, inc: this.inc };
  }
}

/** A belt full of `stack`-item cargo packed to the rear, and the cell of the rear-most one. */
function packedBelt(length: number, speed: number, stack: number): BeltRef {
  const belt = new BeltSim(length, speed);
  for (let p = length - 10; p >= 0; p -= 10) expect(belt.tryInsert(p + 5, { item: ORE, stack, inc: 0 })).toBe(true);
  return { belt, cell: length - 10 };
}

/** A sorter config for sorter building `itemId` at `span`, with the tech state of `effects`. */
function configOf(
  itemId: number,
  span: number,
  pick: SorterConfig['pick'],
  drop: SorterConfig['drop'],
  filter = 0,
  effects = fixtureEffects,
): SorterConfig {
  const sorter = fixtureData.building(itemId)?.sorter;
  if (!sorter) throw new Error(`no sorter ${itemId}`);
  return { pick, drop, filter, ...sorterSettings(sorter, span, effects) };
}

/** Run `ticks` ticks at `power`, updating `belts` after each sorter tick like the world does. */
function run(sorter: SorterSim, ticks: number, belts: BeltSim[] = [], power = 1, each?: (t: number) => void): void {
  for (let t = 0; t < ticks; t++) {
    each?.(t);
    sorter.tick(power);
    for (const belt of belts) belt.update();
  }
}

/** Items per second the sorter delivers over `MEASURE` ticks after `WARMUP` ticks. */
function measureRate(sorter: SorterSim, belts: BeltSim[], moved: () => number): number {
  run(sorter, WARMUP, belts);
  const before = moved();
  run(sorter, MEASURE, belts);
  return ((moved() - before) * 60) / MEASURE;
}

describe('sorterSettings', () => {
  const settings = (itemId: number, span: number, effects = fixtureEffects) => {
    const sorter = fixtureData.building(itemId)?.sorter;
    if (!sorter) throw new Error('no sorter');
    return sorterSettings(sorter, span, effects);
  };

  it('scales stt by span for Mk.I to Mk.III and takes grade parameters from MX §3.2', () => {
    expect(settings(ITEM.sorter.mk1, 1)).toEqual({ grade: 1, stt: 200000, delay: 0, stackInput: 1, stackOutput: 1 });
    expect(settings(ITEM.sorter.mk1, 3).stt).toBe(600000);
    expect(settings(ITEM.sorter.mk2, 2).stt).toBe(200000);
    expect(settings(ITEM.sorter.mk3, 3)).toEqual({ grade: 3, stt: 150000, delay: 0, stackInput: 1, stackOutput: 1 });
  });

  it('does not scale the pile sorter stt by span, and takes its stacking from the tech state', () => {
    expect(settings(ITEM.sorter.pile, 1)).toEqual({ grade: 4, stt: 30000, delay: 40000, stackInput: 2, stackOutput: 1 });
    expect(settings(ITEM.sorter.pile, 3).stt).toBe(30000);
    const maxed = settings(ITEM.sorter.pile, 1, { ...fixtureEffects, inserterStackInput: 4, inserterStackOutput: 3 });
    expect(maxed).toMatchObject({ stackInput: 4, stackOutput: 3, delay: 40000 });
    const single = settings(ITEM.sorter.pile, 1, { ...fixtureEffects, inserterStackInput: 1 });
    expect(single).toMatchObject({ stackInput: 1, delay: 0 });
  });

  it('never lets stt fall below one tick', () => {
    const sorter = { ...fixtureData.building(ITEM.sorter.mk3)!.sorter!, stt: 4000 };
    expect(sorterSettings(sorter, 1, fixtureEffects).stt).toBe(10000);
  });
});

describe('SorterSim throughput from a belt into an always-needing target', () => {
  it.each([
    { name: 'Mk.I span 1', itemId: ITEM.sorter.mk1, span: 1, perSecond: 1.5 },
    { name: 'Mk.II span 1', itemId: ITEM.sorter.mk2, span: 1, perSecond: 3 },
    { name: 'Mk.III span 1', itemId: ITEM.sorter.mk3, span: 1, perSecond: 6 },
    { name: 'Mk.I span 2', itemId: ITEM.sorter.mk1, span: 2, perSecond: 0.75 },
    { name: 'Mk.I span 3', itemId: ITEM.sorter.mk1, span: 3, perSecond: 0.5 },
    { name: 'Mk.II span 2', itemId: ITEM.sorter.mk2, span: 2, perSecond: 1.5 },
    { name: 'Mk.II span 3', itemId: ITEM.sorter.mk2, span: 3, perSecond: 1 },
    { name: 'Mk.III span 2', itemId: ITEM.sorter.mk3, span: 2, perSecond: 3 },
    { name: 'Mk.III span 3', itemId: ITEM.sorter.mk3, span: 3, perSecond: 2 },
  ])('$name moves $perSecond items/s of 1-stack cargo (MX §3.2 table)', ({ itemId, span, perSecond }) => {
    const pick = packedBelt(4000, 5, 1);
    const target = new FakeTarget();
    const sorter = new SorterSim(configOf(itemId, span, pick, target));
    const rate = measureRate(sorter, [pick.belt], () => target.items);
    expect(rate).toBeGreaterThanOrEqual(perSecond * 0.97);
    expect(rate).toBeLessThanOrEqual(perSecond * 1.03);
  });

  it('moves 24 items/s with a Mk.III from a belt of 4-stacks: one cargo per trip', () => {
    const pick = packedBelt(4000, 5, 4);
    const target = new FakeTarget();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, pick, target));
    const rate = measureRate(sorter, [pick.belt], () => target.items);
    expect(rate).toBeGreaterThanOrEqual(24 * 0.97);
    expect(rate).toBeLessThanOrEqual(24 * 1.03);
    expect(target.calls.every((c) => c.count === 4)).toBe(true);
  });

  it('carries the proliferator points of the cargo into the target', () => {
    const belt = new BeltSim(200, 5);
    belt.tryInsert(195, { item: ORE, stack: 3, inc: 9 });
    const target = new FakeTarget();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, { belt, cell: 190 }, target));
    run(sorter, 20, [belt]);
    expect(target.calls).toEqual([{ item: ORE, count: 3, inc: 9 }]);
  });

  it('counts the items it has moved', () => {
    const pick = packedBelt(400, 5, 2);
    const target = new FakeTarget();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, pick, target));
    run(sorter, 100, [pick.belt]);
    expect(sorter.itemsMoved).toBe(target.items);
    expect(target.items).toBe(20); // 10 trips of 2
  });

  it('moves belt to belt too', () => {
    const pick = packedBelt(4000, 5, 1);
    const drop = new BeltSim(100, 5);
    const sorter = new SorterSim(configOf(ITEM.sorter.mk2, 1, pick, { belt: drop, cell: 20 }));
    let arrived = 0;
    const drain = () => {
      while (drop.tryPickRear(0)) arrived++;
    };
    run(sorter, WARMUP, [pick.belt, drop], 1, drain);
    const before = arrived;
    run(sorter, MEASURE, [pick.belt, drop], 1, drain);
    const rate = ((arrived - before) * 60) / MEASURE;
    expect(rate).toBeGreaterThanOrEqual(3 * 0.97);
    expect(rate).toBeLessThanOrEqual(3 * 1.03);
  });
});

describe('SorterSim stages and timing', () => {
  it('follows Picking, Sending, Inserting, Returning with the pick tick as the first Sending tick', () => {
    const target = new FakeTarget();
    const supply = new Supply();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, supply, target));
    const stages: string[] = [];
    run(sorter, 12, [], 1, () => stages.push(sorter.stage));
    // stage at the start of each tick: picks on tick 0, inserts on tick 5 (5 Sending ticks incl. the pick tick),
    // is back to Picking on tick 10.
    expect(stages).toEqual([
      'picking', 'sending', 'sending', 'sending', 'sending', 'inserting',
      'returning', 'returning', 'returning', 'returning', 'picking', 'sending',
    ]);
    expect(target.calls.length).toBe(1);
  });

  it('is working while Sending or Returning, and idle while Picking or Inserting', () => {
    const target = new FakeTarget();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, new Supply(), target));
    let working = 0;
    const flags: boolean[] = [];
    for (let t = 0; t < 100; t++) {
      sorter.tick(1);
      flags.push(sorter.workingThisTick());
      if (sorter.workingThisTick()) working++;
    }
    expect(working).toBe(80); // 8 of every 10-tick cycle: the last Sending and last Returning tick end idle
    expect(flags.slice(0, 10)).toEqual([true, true, true, true, false, true, true, true, true, false]);
  });

  it('is idle with nothing to pick and while blocked inserting', () => {
    const empty = new SorterSim(configOf(ITEM.sorter.mk3, 1, new Supply(0), new FakeTarget()));
    for (let t = 0; t < 50; t++) {
      empty.tick(1);
      expect(empty.workingThisTick()).toBe(false);
    }
    const target = new FakeTarget();
    target.accepting = false;
    const blocked = new SorterSim(configOf(ITEM.sorter.mk3, 1, new Supply(), target));
    run(blocked, 30);
    expect(blocked.stage).toBe('inserting');
    expect(blocked.workingThisTick()).toBe(false);
  });

  it('does nothing below 10 % power and stretches every stage in proportion above it', () => {
    const supply = new Supply();
    const target = new FakeTarget();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk2, 1, supply, target));
    run(sorter, 200, [], 0.099);
    expect(supply.pickCalls).toBe(0);
    expect(sorter.stage).toBe('picking');
    expect(target.items).toBe(0);

    const half = new Supply();
    const halfTarget = new FakeTarget();
    const slow = new SorterSim(configOf(ITEM.sorter.mk2, 1, half, halfTarget));
    run(slow, WARMUP, [], 0.5);
    const before = halfTarget.items;
    run(slow, MEASURE, [], 0.5);
    const rate = ((halfTarget.items - before) * 60) / MEASURE;
    expect(rate).toBeGreaterThanOrEqual(1.5 * 0.97); // Mk.II at half power: 3/s -> 1.5/s
    expect(rate).toBeLessThanOrEqual(1.5 * 1.03);
  });

  it('treats a NaN power as no power', () => {
    const supply = new Supply();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, supply, new FakeTarget()));
    run(sorter, 50, [], NaN);
    expect(supply.pickCalls).toBe(0);
  });
});

describe('SorterSim target needs', () => {
  it('waits and moves nothing while the target needs nothing', () => {
    const pick = packedBelt(400, 5, 1);
    const target = new FakeTarget();
    target.needing = false;
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, pick, target));
    const cargo = pick.belt.cargoCount();
    run(sorter, 600, [pick.belt]);
    expect(target.items).toBe(0);
    expect(pick.belt.cargoCount()).toBe(cargo);
    expect(sorter.stage).toBe('picking');
    expect(sorter.workingThisTick()).toBe(false);
  });

  it('picks only items the target needs, letting the others go by', () => {
    const belt = new BeltSim(200, 5);
    belt.tryInsert(105, { item: 1002, stack: 1, inc: 0 }); // not needed, ahead of the wanted one
    belt.tryInsert(85, { item: ORE, stack: 1, inc: 0 });
    const target = new FakeTarget();
    target.only = ORE;
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, { belt, cell: 150 }, target));
    run(sorter, 60, [belt]);
    expect(target.calls).toEqual([{ item: ORE, count: 1, inc: 0 }]);
    expect(belt.cargoCount()).toBe(1); // the unwanted cargo went on to the rear
  });

  it('backs off 10 ticks after finding that a filtered item is not needed, then polls again', () => {
    const supply = new Supply();
    const target = new FakeTarget();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, supply, target, ORE));
    // needs() goes true on tick 5; the sorter looked on tick 0, set idleTick = 9 and skips ticks 1 to 9.
    let t = 0;
    run(sorter, 12, [], 1, () => {
      supply.tick = t;
      target.needing = t >= 5;
      t++;
    });
    expect(supply.firstPickCallTick).toBe(10);
    expect(supply.pickCalls).toBeGreaterThanOrEqual(1);
    expect(sorter.stage).toBe('sending');
  });

  it('polls every tick when it has no filter, because it cannot tell that nothing is needed', () => {
    const supply = new Supply();
    const target = new FakeTarget();
    target.needing = false;
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, supply, target, 0));
    run(sorter, 25);
    expect(supply.pickCalls).toBe(25);
    expect(sorter.stage).toBe('picking');
    expect(supply.lastAccept?.(ORE)).toBe(false);
  });

  it('does not ask a target that does not care about needs, and picks regardless', () => {
    const supply = new Supply();
    const target = new FakeTarget(false);
    target.needing = false;
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, supply, target, ORE));
    run(sorter, 12);
    expect(target.items).toBe(1);
    expect(supply.lastAccept?.(ORE)).toBe(true);
  });

  it('holds what it picked when the target stops needing it, and inserts once it needs it again', () => {
    const supply = new Supply();
    const target = new FakeTarget();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, supply, target, ORE));
    run(sorter, 4); // picked on tick 0, Sending
    target.needing = false;
    run(sorter, 40);
    expect(sorter.stage).toBe('inserting');
    expect(target.items).toBe(0);
    target.needing = true;
    run(sorter, 1);
    expect(sorter.stage).toBe('returning');
    expect(target.items).toBe(1);
  });

  it('waits in Inserting while the target refuses the insert', () => {
    const supply = new Supply();
    const target = new FakeTarget(false);
    target.accepting = false;
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, supply, target));
    run(sorter, 100);
    expect(sorter.stage).toBe('inserting');
    expect(supply.pickCalls).toBe(1); // picked once (tick 0), then held: no more Picking ticks
    target.accepting = true;
    run(sorter, 1);
    expect(target.items).toBe(1);
  });
});

describe('SorterSim pile sorter', () => {
  const pileConfig = (
    pick: SorterConfig['pick'],
    drop: SorterConfig['drop'],
    over: Partial<{ stackInput: number; stackOutput: number }> = {},
  ): SorterConfig =>
    configOf(ITEM.sorter.pile, 1, pick, drop, 0, {
      ...fixtureEffects,
      inserterStackInput: over.stackInput ?? 4,
      inserterStackOutput: over.stackOutput ?? 1,
    });

  it('accumulates up to StackInput picks from 1-stack cargo before it leaves', () => {
    const supply = new Supply();
    const target = new FakeTarget();
    const sorter = new SorterSim(pileConfig(supply, target));
    run(sorter, 3);
    expect(sorter.stage).toBe('picking'); // three items held, one more to come
    run(sorter, 1);
    expect(sorter.stage).toBe('sending'); // fourth pick on tick 3: full, leaves at once
    run(sorter, 60);
    expect(target.items % 4).toBe(0);
    expect(target.calls.slice(0, 4)).toEqual(Array(4).fill({ item: ORE, count: 1, inc: 0 }));
  });

  it('accumulates from a belt of 1-stack cargo too', () => {
    const pick = packedBelt(400, 5, 1);
    const target = new FakeTarget();
    const sorter = new SorterSim(pileConfig(pick, target));
    run(sorter, 40, [pick.belt]);
    expect(target.items).toBeGreaterThanOrEqual(4);
    expect(target.items % 4).toBe(0);
  });

  it('unloads a saturated Mk.III belt of 1-stack cargo at base upgrade level at 12 to 15 items/s (wiki: 800/min)', () => {
    // A cargo every 2 ticks passes the sorter, which loads 2 and unstacks 2: 8 or 9 ticks per trip depending on
    // how the stream's phase meets the 5-cell pick window.
    const belt = new BeltSim(300, 5);
    const target = new FakeTarget();
    const sorter = new SorterSim(
      configOf(ITEM.sorter.pile, 1, { belt, cell: 100 }, target, 0, {
        ...fixtureEffects,
        inserterStackInput: 2,
        inserterStackOutput: 1,
      }),
    );
    const feed = () => {
      belt.tryInsertAtHead({ item: ORE, stack: 1, inc: 0 });
      belt.tryPickRear(0);
    };
    run(sorter, WARMUP, [belt], 1, feed);
    const before = target.items;
    run(sorter, MEASURE, [belt], 1, feed);
    const rate = ((target.items - before) * 60) / MEASURE;
    expect(rate).toBeGreaterThanOrEqual(12 * 0.97);
    expect(rate).toBeLessThanOrEqual(15 * 1.03);
  });

  it('leaves after Delay without a new pick, with the items it has', () => {
    const supply = new Supply(2); // only two products to give
    const target = new FakeTarget();
    const sorter = new SorterSim(pileConfig(supply, target));
    run(sorter, 4); // ticks 0, 1 pick; ticks 2, 3 find nothing
    expect(sorter.stage).toBe('picking');
    run(sorter, 1); // tick 4: 4 ticks since the last pick -> Delay 40000 reached
    expect(sorter.stage).toBe('sending');
    run(sorter, 40);
    expect(target.items).toBe(2);
  });

  it('only picks more of the item it already holds', () => {
    // A, B and C pass the sorter in turn: ore, something else, ore. Delay is long enough to wait for C.
    const belt = new BeltSim(400, 5);
    belt.tryInsert(105, { item: ORE, stack: 1, inc: 0 });
    belt.tryInsert(95, { item: 1002, stack: 1, inc: 0 });
    belt.tryInsert(85, { item: ORE, stack: 1, inc: 0 });
    const target = new FakeTarget();
    const sorter = new SorterSim({ ...pileConfig({ belt, cell: 200 }, target, { stackInput: 2 }), delay: 100000 });
    run(sorter, 80, [belt]);
    expect(target.calls).toEqual([
      { item: ORE, count: 1, inc: 0 },
      { item: ORE, count: 1, inc: 0 },
    ]);
    expect(belt.cargoCount()).toBe(1); // the other item went on to the rear
  });

  it('unstacks onto a belt when StackOutput is 1', () => {
    const supply = new Supply();
    const drop = new BeltSim(60, 5);
    const sorter = new SorterSim(pileConfig(supply, { belt: drop, cell: 20 }, { stackOutput: 1 }));
    const got = collect(sorter, drop, 60);
    expect(got.slice(0, 4)).toEqual(Array(4).fill({ item: ORE, stack: 1, inc: 0 }));
  });

  it('builds stacks of up to StackOutput onto a belt', () => {
    const supply = new Supply();
    const drop = new BeltSim(60, 5);
    const sorter = new SorterSim(pileConfig(supply, { belt: drop, cell: 20 }, { stackOutput: 2 }));
    const got = collect(sorter, drop, 60);
    expect(got.slice(0, 2)).toEqual(Array(2).fill({ item: ORE, stack: 2, inc: 0 }));
  });

  it('splits proliferator points across the cargo it builds without losing any', () => {
    const supply = new Supply(Infinity, ORE, 1, 3);
    const drop = new BeltSim(60, 5);
    const sorter = new SorterSim(pileConfig(supply, { belt: drop, cell: 20 }, { stackOutput: 3 }));
    const got = collect(sorter, drop, 60);
    expect(got[0]).toEqual({ item: ORE, stack: 3, inc: 9 });
    expect(got[1]).toEqual({ item: ORE, stack: 1, inc: 3 });
  });
});

/** Run `sorter` for `ticks` ticks while the rear of `drop` is drained; the cargo it drained, in order. */
function collect(sorter: SorterSim, drop: BeltSim, ticks: number): Cargo[] {
  const got: Cargo[] = [];
  run(sorter, ticks, [drop], 1, () => {
    for (let c = drop.tryPickRear(0); c; c = drop.tryPickRear(0)) got.push(c);
  });
  return got;
}

describe('SorterSim onto a belt from a building', () => {
  it('inserts one cargo per trip', () => {
    const supply = new Supply();
    const drop = new BeltSim(60, 5);
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, supply, { belt: drop, cell: 20 }));
    const got = collect(sorter, drop, 100);
    expect(got.length).toBe(9); // trips finish on ticks 5, 15, ..., 95; the last needs 8 ticks to reach the rear
    expect(got.every((c) => c.item === ORE && c.stack === 1 && c.inc === 0)).toBe(true);
    expect(sorter.itemsMoved).toBe(10);
  });

  it('waits while the belt has no gap and goes on when one opens', () => {
    const supply = new Supply();
    const drop = new BeltSim(100, 5);
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, supply, { belt: drop, cell: 50 }));
    run(sorter, 200); // the belt never moves: the first cargo sits at the drop point
    expect(drop.cargoCount()).toBe(1);
    expect(sorter.stage).toBe('inserting');
    expect(sorter.itemsMoved).toBe(1);
    expect(supply.pickCalls).toBe(2); // it picked the second item and holds it
    expect(drop.tryPick(50, 0)).not.toBeNull(); // the cargo leaves
    run(sorter, 1);
    expect(sorter.stage).toBe('returning');
    expect(drop.cargoCount()).toBe(1);
    expect(sorter.itemsMoved).toBe(2);
  });
});

describe('SorterSim attachment cell', () => {
  it('clamps the pick cell into 4..length-6 like the game does', () => {
    // A cargo whose first cell is 6 is seen from cell 4 (window 4-6 .. 4+2) but not from cell 0 (-6 .. 2).
    const head = new BeltSim(100, 1);
    head.tryInsert(11, { item: ORE, stack: 1, inc: 0 });
    expect(head.cargoCells()).toEqual([6]);
    const target = new FakeTarget();
    const sorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, { belt: head, cell: 0 }, target));
    run(sorter, 1);
    expect(sorter.stage).toBe('sending');

    // A cargo stopped at the rear (first cell length-10) is out of reach of cell length-1 unless it is clamped.
    const tail = new BeltSim(100, 1);
    tail.tryInsert(95, { item: ORE, stack: 1, inc: 0 });
    for (let t = 0; t < 100; t++) tail.update();
    expect(tail.cargoCells()).toEqual([90]);
    const tailSorter = new SorterSim(configOf(ITEM.sorter.mk3, 1, { belt: tail, cell: 99 }, new FakeTarget()));
    run(tailSorter, 1);
    expect(tailSorter.stage).toBe('sending');
  });

  it('rejects a cell outside its belt and settings that cannot work', () => {
    const belt = new BeltSim(100, 1);
    const target = new FakeTarget();
    const ok = configOf(ITEM.sorter.mk3, 1, { belt, cell: 50 }, target);
    expect(() => new SorterSim({ ...ok, pick: { belt, cell: 100 } })).toThrow(/cell 100/);
    expect(() => new SorterSim({ ...ok, drop: { belt, cell: -1 } })).toThrow(/cell -1/);
    expect(() => new SorterSim({ ...ok, stt: 0 })).toThrow(/stt/);
    expect(() => new SorterSim({ ...ok, stackInput: 0 })).toThrow(/stackInput/);
    expect(() => new SorterSim({ ...ok, stackOutput: 0 })).toThrow(/stackOutput/);
    expect(() => new SorterSim({ ...ok, delay: -1 })).toThrow(/delay/);
    expect(() => new SorterSim({ ...ok, filter: -1 })).toThrow(/filter/);
  });
});
