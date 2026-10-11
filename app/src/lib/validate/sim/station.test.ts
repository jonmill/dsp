import { describe, expect, it } from 'vitest';
import type { StationConfig } from '../../geometry';
import { stationConfig } from '../testkit';
import { BeltSim } from './belt';
import { StationSim } from './station';

/** `stationConfig(slots)` with port `port` set to `dir` and `storageIdx`, and the given piler count. */
function config(
  slots: number,
  ports: Record<number, { dir: 0 | 1 | 2; storageIdx: number }>,
  pilerCount: StationConfig['pilerCount'] = 1,
): StationConfig {
  const cfg = stationConfig(slots);
  cfg.ports = cfg.ports.map((p, i) => ports[i] ?? { dir: 0, storageIdx: 0 });
  cfg.pilerCount = pilerCount;
  return cfg;
}

const OUT0 = { 0: { dir: 1 as const, storageIdx: 1 } };

describe('StationSim output port', () => {
  it('on a Mk.III belt with piler level 4 delivers 4-stacks at no more than 30 cargo/s (120 items/s)', () => {
    const belt = new BeltSim(200, 5);
    const station = new StationSim(config(1, OUT0, 0), 4);
    station.attachOutput(0, belt);
    const cargos: { item: number; stack: number }[] = [];
    for (let t = 0; t < 600; t++) {
      const c = belt.tryPickRear(0);
      if (c) cargos.push(c);
      belt.update();
      station.tick(t);
    }
    expect(cargos.length).toBeLessThanOrEqual(300); // 30 cargo/s over 10 s
    expect(cargos.length).toBeGreaterThanOrEqual(300 - 20); // less the 190 cells (38 ticks) to the rear
    expect(cargos.every((c) => c.item === 1001 && c.stack === 4)).toBe(true);
    const items = cargos.reduce((sum, c) => sum + c.stack, 0);
    expect(items).toBeLessThanOrEqual(1200);
    // It also emitted what is still on the belt: 300 cargo in total, every other tick.
    expect(station.emitted(1001)).toBe(1200);
  });

  it('writes one cargo per 10 ticks on a Mk.I belt, because the head clears only after 10 cells', () => {
    const belt = new BeltSim(1000, 1);
    const station = new StationSim(config(1, OUT0), 1);
    station.attachOutput(0, belt);
    for (let t = 0; t < 600; t++) {
      belt.update();
      station.tick(t);
    }
    expect(belt.cargoCount()).toBe(60); // 6 cargo/s
    expect(station.emitted(1001)).toBe(60);
  });

  it('stops when the belt backs up and resumes when room appears', () => {
    const belt = new BeltSim(50, 5);
    const station = new StationSim(config(1, OUT0), 1);
    station.attachOutput(0, belt);
    for (let t = 0; t < 200; t++) {
      belt.update();
      station.tick(t);
    }
    expect(belt.cargoCount()).toBe(5);
    expect(station.emitted(1001)).toBe(5);
    expect(belt.tryPickRear(0)).not.toBeNull();
    for (let t = 200; t < 220; t++) {
      belt.update();
      station.tick(t);
    }
    expect(belt.cargoCount()).toBe(5);
    expect(station.emitted(1001)).toBe(6);
  });

  it('acts at most once every 2 ticks', () => {
    const belt = new BeltSim(1000, 20); // clears the head in one tick, so only the port's own pace limits it
    const station = new StationSim(config(1, OUT0), 1);
    station.attachOutput(0, belt);
    for (let t = 0; t < 100; t++) {
      belt.update();
      station.tick(t);
    }
    expect(station.emitted(1001)).toBe(50);
  });

  it('outputs the item of the slot the port names', () => {
    const belt = new BeltSim(100, 5);
    const station = new StationSim(config(3, { 4: { dir: 1, storageIdx: 3 } }), 1);
    station.attachOutput(4, belt);
    station.tick(0);
    expect(belt.tryPick(5, 0)).toEqual({ item: 1003, stack: 1, inc: 0 });
  });

  it('outputs nothing when the port names no slot or a slot past the config', () => {
    for (const storageIdx of [0, 2, 9]) {
      const belt = new BeltSim(100, 5);
      const station = new StationSim(config(1, { 0: { dir: 1, storageIdx } }), 1);
      station.attachOutput(0, belt);
      for (let t = 0; t < 50; t++) station.tick(t);
      expect(belt.cargoCount()).toBe(0);
    }
  });

  it('stacks min(pilerCount, tech level), and the tech level when pilerCount is 0', () => {
    const stackFor = (pilerCount: 0 | 1 | 2 | 3 | 4, level: number): number => {
      const belt = new BeltSim(100, 5);
      const station = new StationSim(config(1, OUT0, pilerCount), level);
      station.attachOutput(0, belt);
      station.tick(0);
      return belt.tryPick(5, 0)!.stack;
    };
    expect(stackFor(0, 4)).toBe(4);
    expect(stackFor(0, 1)).toBe(1);
    expect(stackFor(1, 4)).toBe(1);
    expect(stackFor(2, 4)).toBe(2);
    expect(stackFor(4, 2)).toBe(2);
    expect(stackFor(3, 3)).toBe(3);
  });
});

describe('StationSim input port', () => {
  const IN1 = { 1: { dir: 2 as const, storageIdx: 0 } };

  /** A belt with `n` cargo of `item`/`stack` already at the rear. */
  function loadedBelt(n: number, item = 1001, stack = 2, speed = 5): BeltSim {
    const belt = new BeltSim(100, speed);
    for (let t = 0; t < 300; t++) {
      belt.update();
      if (belt.cargoCount() < n) belt.tryInsertAtHead({ item, stack, inc: 0 });
    }
    return belt;
  }

  it('consumes the rear cargo and counts its items', () => {
    const belt = loadedBelt(1, 1001, 3);
    const station = new StationSim(config(1, IN1), 1);
    station.attachInput(1, belt);
    expect(station.received(1001)).toBe(0);
    station.tick(0);
    expect(belt.cargoCount()).toBe(0);
    expect(station.received(1001)).toBe(3);
    expect(station.received(1002)).toBe(0);
  });

  it('takes a backed-up belt one cargo per 2 ticks at most', () => {
    const belt = loadedBelt(10, 1001, 1, 20); // cargo reaches the rear again in one tick
    const station = new StationSim(config(1, IN1), 1);
    station.attachInput(1, belt);
    for (let t = 0; t < 10; t++) {
      station.tick(t);
      belt.update();
    }
    expect(station.received(1001)).toBe(5);
  });

  it('keeps a cargo of an item no slot holds at the rear (it blocks the belt)', () => {
    const belt = loadedBelt(1, 9999, 1);
    const station = new StationSim(config(2, IN1), 1);
    station.attachInput(1, belt);
    for (let t = 0; t < 20; t++) station.tick(t);
    expect(belt.cargoCount()).toBe(1);
    expect(station.received(9999)).toBe(0);
  });

  it('accepts any configured slot item whatever the port storageIdx says', () => {
    const belt = loadedBelt(1, 1002, 1);
    const station = new StationSim(config(2, { 1: { dir: 2, storageIdx: 1 } }), 1);
    station.attachInput(1, belt);
    station.tick(0);
    expect(station.received(1002)).toBe(1);
  });

  it('counts each item id separately, port by port', () => {
    const station = new StationSim(config(2, { 1: { dir: 2, storageIdx: 0 }, 2: { dir: 2, storageIdx: 0 } }), 1);
    station.attachInput(1, loadedBelt(1, 1001, 3));
    station.attachInput(2, loadedBelt(1, 1002, 2));
    station.tick(0);
    expect(station.received(1001)).toBe(3);
    expect(station.received(1002)).toBe(2);
  });
});

describe('StationSim ports', () => {
  it('does nothing with a port whose dir is 0', () => {
    const out = new BeltSim(100, 5);
    const inn = restingBelt();
    const station = new StationSim(config(1, {}), 4);
    station.attachOutput(0, out);
    station.attachInput(1, inn);
    for (let t = 0; t < 100; t++) station.tick(t);
    expect(out.cargoCount()).toBe(0);
    expect(inn.cargoCount()).toBe(1);
    expect(station.emitted(1001)).toBe(0);
    expect(station.received(1001)).toBe(0);
  });

  it('does nothing when the belt is attached to the wrong kind of port', () => {
    const cfg = config(1, { 0: { dir: 1, storageIdx: 1 }, 1: { dir: 2, storageIdx: 0 } });
    const station = new StationSim(cfg, 1);
    const asOutputOnInputPort = new BeltSim(100, 5);
    station.attachOutput(1, asOutputOnInputPort);
    const loaded = restingBelt();
    station.attachInput(0, loaded);
    for (let t = 0; t < 100; t++) station.tick(t);
    expect(asOutputOnInputPort.cargoCount()).toBe(0);
    expect(loaded.cargoCount()).toBe(1);
  });

  it('rejects a port index outside the station', () => {
    const station = new StationSim(config(1, OUT0), 1);
    expect(() => station.attachOutput(12, new BeltSim(100, 1))).toThrow(RangeError);
    expect(() => station.attachInput(-1, new BeltSim(100, 1))).toThrow(RangeError);
  });

  it('runs input and output ports of one station independently', () => {
    const outBelt = new BeltSim(100, 5);
    const inBelt = restingBelt();
    const station = new StationSim(config(1, { 0: { dir: 1, storageIdx: 1 }, 5: { dir: 2, storageIdx: 0 } }), 1);
    station.attachOutput(0, outBelt);
    station.attachInput(5, inBelt);
    station.tick(0);
    expect(outBelt.cargoCount()).toBe(1);
    expect(station.received(1001)).toBe(1);
  });
});

/** One cargo of item 1001 sitting at the rear of a Mk.III belt. */
function restingBelt(): BeltSim {
  const belt = new BeltSim(100, 5);
  belt.tryInsertAtHead({ item: 1001, stack: 1, inc: 0 });
  for (let t = 0; t < 30; t++) belt.update();
  return belt;
}
