import { describe, expect, it } from 'vitest';
import { fixtureData } from '../testkit';
import { BeltSim } from './belt';
import type { Cargo } from './cargo';
import { CoaterSim, coaterConfig } from './coater';
import type { CoaterConfig } from './coater';

const ORE = 1001;
const MK1 = 1141;
const MK2 = 1142;
const MK3 = 1143;
const ITEM_CELL = 100;
const PROLIF_CELL = 50;

const def = fixtureData.building(2313)!;

interface Rig {
  item: BeltSim;
  prolif: BeltSim;
  coater: CoaterSim;
}

function rig(speed: number, over: Partial<CoaterConfig> = {}): Rig {
  const item = new BeltSim(200, speed);
  const prolif = new BeltSim(100, 1);
  const cfg = { ...coaterConfig(def, { belt: item, cell: ITEM_CELL }, { belt: prolif, cell: PROLIF_CELL }, fixtureData), ...over };
  return { item, prolif, coater: new CoaterSim(cfg) };
}

const put = (prolif: BeltSim, item: number, stack = 1, inc = 0): boolean =>
  prolif.tryInsert(PROLIF_CELL, { item, stack, inc });

/**
 * Stream `stack`-item ore cargo through the coater for `ticks` ticks, topping up the proliferator belt whenever it
 * has room, and return every cargo that reaches the rear, in order.
 */
function stream(r: Rig, ticks: number, opts: { stack?: number; inc?: number; power?: number; prolif?: () => Cargo | null } = {}): Cargo[] {
  const { stack = 1, inc = 0, power = 1, prolif = () => ({ item: MK3, stack: 4, inc: 0 }) } = opts;
  const out: Cargo[] = [];
  for (let t = 0; t < ticks; t++) {
    r.item.tryInsertAtHead({ item: ORE, stack, inc });
    const p = prolif();
    if (p) r.prolif.tryInsert(PROLIF_CELL, p);
    r.coater.tick(power);
    r.item.update();
    for (let c = r.item.tryPickRear(0); c !== null; c = r.item.tryPickRear(0)) out.push(c);
  }
  return out;
}

describe('CoaterSim spraying', () => {
  it.each([
    [1, 1],
    [2, 1],
    [5, 1],
    [1, 4],
    [5, 4],
  ])('on a speed-%i belt every passing stack-%i cargo gets stack x ability points (Mk.III: 4 each)', (speed, stack) => {
    const r = rig(speed);
    const out = stream(r, 3000, { stack });
    expect(out.length).toBeGreaterThan(100);
    for (const c of out) expect(c).toEqual({ item: ORE, stack, inc: stack * 4 });
    expect(r.coater.sprayedCargo).toBeGreaterThanOrEqual(out.length);
  });

  it('uses the ability of the proliferator it holds: Mk.I 1, Mk.II 2 per item', () => {
    for (const [item, ability] of [[MK1, 1], [MK2, 2]] as const) {
      const r = rig(2);
      const out = stream(r, 1500, { stack: 3, prolif: () => ({ item, stack: 4, inc: 0 }) });
      expect(out.length).toBeGreaterThan(50);
      for (const c of out) expect(c.inc).toBe(3 * ability);
    }
  });

  it('consumes one spray per item of a cargo, then passes cargo unsprayed when it has run out', () => {
    const r = rig(2);
    put(r.prolif, MK3, 1); // 60 sprays and no more
    const out = stream(r, 3000, { stack: 3, prolif: () => null });
    const sprayed = out.filter((c) => c.inc > 0);
    const bare = out.filter((c) => c.inc === 0);
    expect(sprayed).toHaveLength(20); // 60 / 3
    expect(sprayed.every((c) => c.inc === 12)).toBe(true);
    expect(bare.length).toBeGreaterThan(50);
    expect(r.coater.sprays).toBe(0);
    // The sprayed ones came first.
    expect(out.slice(0, 20).every((c) => c.inc === 12)).toBe(true);
    expect(out.slice(20).every((c) => c.inc === 0)).toBe(true);
    // It forgets the proliferator type when it runs dry: a Mk.I cargo is taken now, worth 1 point per item.
    put(r.prolif, MK1, 1);
    const more = stream(r, 600, { stack: 1, prolif: () => null });
    const marked = more.filter((c) => c.inc > 0);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((c) => c.inc === c.stack)).toBe(true);
  });

  it('does not spray a cargo that already carries as many points, and keeps its sprays', () => {
    const r = rig(2);
    put(r.prolif, MK3, 1);
    r.coater.tick(1); // takes the proliferator while the item belt is empty
    expect(r.coater.sprays).toBe(60);
    const out = stream(r, 1500, { stack: 2, inc: 8, prolif: () => null });
    expect(out.length).toBeGreaterThan(30);
    expect(out.every((c) => c.inc === 8)).toBe(true);
    expect(r.coater.sprays).toBe(60);
    expect(r.coater.sprayedCargo).toBe(0);
  });

  it('leaves a cargo with more points than the coater would give alone', () => {
    const r = rig(2);
    put(r.prolif, MK1, 1); // ability 1
    const out = stream(r, 600, { stack: 2, inc: 8, prolif: () => null }); // Mk.III-sprayed already
    expect(out.every((c) => c.inc === 8)).toBe(true);
  });

  it('keeps pace with a full belt: Mk.I belt, Mk.II belt and Mk.III belt each spray 100 % of a dense stream', () => {
    for (const speed of [1, 2, 5]) {
      const r = rig(speed);
      const out = stream(r, 4000);
      const bare = out.filter((c) => c.inc === 0).length;
      expect(bare, `speed ${speed}`).toBe(0);
    }
  });
});

describe('CoaterSim proliferator intake', () => {
  it.each([
    [MK1, 0, 12],
    [MK2, 0, 24],
    [MK3, 0, 60],
    [MK1, 1, 13],
    [MK2, 2, 28],
    [MK3, 4, 75],
  ])('a proliferator %i carrying %i points per item adds %i sprays', (item, incPerItem, sprays) => {
    const r = rig(1);
    put(r.prolif, item, 1, incPerItem);
    r.coater.tick(1);
    expect(r.coater.sprays).toBe(sprays);
    expect(r.prolif.cargoCount()).toBe(0);
  });

  it('counts every item of a stacked cargo', () => {
    const r = rig(1);
    put(r.prolif, MK3, 4, 16); // 4 items, 4 points each
    r.coater.tick(1);
    expect(r.coater.sprays).toBe(4 * 75);
  });

  it('stops taking proliferator once its 600 sprays are full, and lets the rest pass', () => {
    const r = rig(1);
    for (let t = 0; t < 400; t++) {
      put(r.prolif, MK3, 4);
      r.coater.tick(1);
    }
    expect(r.coater.sprays).toBeGreaterThanOrEqual(600);
    expect(r.coater.sprays).toBeLessThan(600 + 4 * 60); // takes a cargo while below capacity: may overshoot by one
    expect(r.prolif.cargoCount()).toBe(1); // the cargo it did not take
  });

  it('takes one proliferator type at a time and passes the other by', () => {
    const r = rig(1);
    put(r.prolif, MK3, 1);
    r.coater.tick(1);
    expect(r.coater.sprays).toBe(60);
    put(r.prolif, MK2, 1);
    for (let t = 0; t < 20; t++) r.coater.tick(1);
    expect(r.coater.sprays).toBe(60);
    expect(r.prolif.cargoCount()).toBe(1);
    put(r.prolif, MK3, 1); // cannot: the belt cell is taken, so clear it first
    expect(r.prolif.tryPick(PROLIF_CELL, MK2)).not.toBeNull();
    put(r.prolif, MK3, 1);
    r.coater.tick(1);
    expect(r.coater.sprays).toBe(120);
  });

  it('ignores cargo that is not a proliferator', () => {
    const r = rig(1);
    put(r.prolif, ORE, 4);
    for (let t = 0; t < 20; t++) r.coater.tick(1);
    expect(r.coater.sprays).toBe(0);
    expect(r.prolif.cargoCount()).toBe(1);
  });
});

describe('CoaterSim power', () => {
  it('does nothing below 10 % power: no intake, no spray', () => {
    const r = rig(2);
    put(r.prolif, MK3, 4);
    const out = stream(r, 1000, { power: 0.09, prolif: () => null });
    expect(r.coater.sprays).toBe(0);
    expect(out.every((c) => c.inc === 0)).toBe(true);
    expect(r.coater.workingThisTick()).toBe(false);
  });

  it('sprays at the reduced rate when power is short: 50 % power sprays about half of a dense stream', () => {
    const r = rig(2);
    const out = stream(r, 4000, { power: 0.5 });
    const sprayed = out.filter((c) => c.inc > 0).length;
    expect(sprayed / out.length).toBeGreaterThan(0.4);
    expect(sprayed / out.length).toBeLessThan(0.6);
  });

  it('works while a cargo it can spray is in front of it, and idles on an empty belt or without sprays', () => {
    const r = rig(1);
    r.coater.tick(1);
    expect(r.coater.workingThisTick()).toBe(false); // nothing to take, nothing in front
    put(r.prolif, MK3, 4);
    r.item.tryInsert(ITEM_CELL, { item: ORE, stack: 1, inc: 0 });
    r.coater.tick(1);
    expect(r.coater.workingThisTick()).toBe(true);
    expect(r.coater.sprayedCargo).toBe(1);
    r.coater.tick(1); // the same cargo, already sprayed
    expect(r.coater.workingThisTick()).toBe(false);

    const dry = rig(1);
    dry.item.tryInsert(ITEM_CELL, { item: ORE, stack: 1, inc: 0 });
    dry.coater.tick(1);
    expect(dry.coater.workingThisTick()).toBe(false);
  });
});

describe('coaterConfig', () => {
  it('reads the capacity, the proliferator items and the tables from GameData', () => {
    const cfg = coaterConfig(def, { belt: new BeltSim(100, 1), cell: 50 }, { belt: new BeltSim(100, 1), cell: 50 }, fixtureData);
    expect(cfg.incCapacity).toBe(600);
    expect([...cfg.proliferators.keys()]).toEqual([MK1, MK2, MK3]);
    expect(cfg.proliferators.get(MK3)).toEqual({ ability: 4, sprays: 60 });
    expect(cfg.incTableMilli[4]).toBe(250);
  });

  it('rejects a building that is not a spray coater', () => {
    const belt = { belt: new BeltSim(100, 1), cell: 50 };
    expect(() => coaterConfig(fixtureData.building(2302)!, belt, belt, fixtureData)).toThrow(/Smelter/);
  });
});
