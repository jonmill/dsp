import { describe, expect, it } from 'vitest';
import { fixtureData, fixtureEffects, LayoutKit, line, planOf, stationPairLayout } from '../testkit';
import { World } from './world';
import type { Phase } from './world';

const plan = planOf([]);

function worldOf(kit: LayoutKit, over: Partial<typeof fixtureEffects> = {}, opts?: { powerSupplyW?: number }): World {
  return new World(kit.layout(), plan, fixtureData, { ...fixtureEffects, ...over }, opts);
}

describe('World belts', () => {
  it('sizes a belt from its nodes and port stubs and maps nodes to cells', () => {
    const { kit, belt } = stationPairLayout(1, 4);
    const lone = kit.belt(2, 1001, line([0, 9], [2, 9])); // no ports: no stubs
    const world = worldOf(kit);
    // 4 nodes · 20 cells, plus a 20-cell stub at each port end.
    expect(world.belt(belt.id).length).toBe(120);
    expect(world.belt(belt.id).speed).toBe(1);
    expect(world.cellOfNode(belt.id, 0)).toBe(30); // stub 20 + half a tile
    expect(world.cellOfNode(belt.id, 3)).toBe(90);
    expect(world.belt(lone.id).length).toBe(60);
    expect(world.belt(lone.id).speed).toBe(2);
    expect(world.cellOfNode(lone.id, 0)).toBe(10);
    expect(world.cellOfNode(lone.id, 2)).toBe(50);
    const cell = world.beltCell(belt.id, 1);
    expect(cell.belt).toBe(world.belt(belt.id));
    expect(cell.cell).toBe(50);
  });

  it('takes the belt speed from the tier', () => {
    const kit = new LayoutKit();
    const a = kit.belt(1, 1001, line([0, 0], [3, 0]));
    const b = kit.belt(2, 1001, line([0, 2], [3, 2]));
    const c = kit.belt(3, 1001, line([0, 4], [3, 4]));
    const world = worldOf(kit);
    expect([a, b, c].map((x) => world.belt(x.id).speed)).toEqual([1, 2, 5]);
  });

  it('rejects an unknown belt, a node outside the belt and a belt tier that is not a belt', () => {
    const { kit, belt } = stationPairLayout(1, 4);
    const world = worldOf(kit);
    expect(() => world.belt(99)).toThrow(/belt 99/);
    expect(() => world.beltCell(belt.id, 4)).toThrow(/node 4/);
    expect(() => world.beltCell(belt.id, -1)).toThrow(/node -1/);
    const bad = new LayoutKit();
    bad.belt(1, 1001, line([0, 0], [3, 0]), { tierItemId: 2201 as never });
    expect(() => worldOf(bad)).toThrow(/belt/);
  });

  it('wires a sink belt as a merge into the target belt, so items flow on to the target\'s station', () => {
    const kit = new LayoutKit();
    const a = kit.station(0, 0);
    const b = kit.station(40, 0);
    b.station!.ports[1] = { dir: 2, storageIdx: 0 };
    const main = kit.belt(1, 1001, line([0, 5], [5, 5]), { sink: { kind: 'port', buildingId: b.id, port: 1 } });
    const side = kit.belt(1, 1001, line([3, 0], [3, 4]), {
      source: { buildingId: a.id, port: 0 },
      sink: { kind: 'belt', beltId: main.id, node: 3 },
    });
    const world = worldOf(kit);
    for (let t = 0; t < 3000; t++) world.tick();
    // 6 cargo/s from the side belt, about 180 ticks of latency.
    expect(world.station(b.id).received(1001)).toBeGreaterThan(270);
    expect(world.station(b.id).received(1001)).toBeLessThan(290);
    expect(world.belt(side.id).cargoCount()).toBeLessThan(world.belt(side.id).length / 10);
    expect(world.cellOfNode(main.id, 3)).toBe(3 * 20 + 10);
  });

  it('rejects a merge into an unknown belt, and a port link to a building that is not a station', () => {
    const missing = stationPairLayout(1, 4);
    missing.kit.belt(1, 1001, line([0, 8], [3, 8]), { sink: { kind: 'belt', beltId: 77, node: 0 } });
    expect(() => worldOf(missing.kit)).toThrow(/belt 77/);

    const notStation = stationPairLayout(1, 4);
    const asm = notStation.kit.assembler(20, 20);
    notStation.kit.belt(1, 1001, line([0, 8], [3, 8]), { source: { buildingId: asm.id, port: 0 } });
    expect(() => worldOf(notStation.kit)).toThrow(new RegExp(`building ${asm.id}`));

    const noBuilding = stationPairLayout(1, 4);
    noBuilding.kit.belt(1, 1001, line([0, 8], [3, 8]), { sink: { kind: 'port', buildingId: 55, port: 1 } });
    expect(() => worldOf(noBuilding.kit)).toThrow(/building 55/);
  });
});

describe('World stations', () => {
  it('moves items from a station output port over a belt into a station input port', () => {
    const { kit, source, sink } = stationPairLayout(1, 10);
    const world = worldOf(kit);
    for (let t = 0; t < 3000; t++) world.tick();
    expect(world.ticks).toBe(3000);
    // A cargo every 10 ticks, 230 cells to the rear, taken the tick after it arrives: ticks 10i + 231 <= 2999.
    expect(world.station(sink.id).received(1001)).toBe(277);
    expect(world.station(source.id).emitted(1001)).toBeGreaterThanOrEqual(300);
  });

  it('sustains 120 items/s through one Mk.III belt with piler level 4', () => {
    const { kit, source, sink } = stationPairLayout(3, 10);
    source.station!.pilerCount = 0;
    const world = worldOf(kit, { stationPilerLevel: 4 });
    for (let t = 0; t < 600; t++) world.tick();
    const before = world.station(sink.id).received(1001);
    for (let t = 0; t < 6000; t++) world.tick();
    const rate = (world.station(sink.id).received(1001) - before) / 100;
    expect(rate).toBeGreaterThan(120 * 0.99);
    expect(rate).toBeLessThanOrEqual(120 * 1.01);
  });

  it('uses the researched stacking level for pilerCount 0 and caps pilerCount by it', () => {
    const { kit, source, sink } = stationPairLayout(3, 4);
    source.station!.pilerCount = 0;
    const world = worldOf(kit, { stationPilerLevel: 3 });
    expect(world.station(source.id).outputStack).toBe(3);
    source.station!.pilerCount = 4;
    expect(worldOf(kit, { stationPilerLevel: 2 }).station(source.id).outputStack).toBe(2);
    expect(() => world.station(999)).toThrow(/building 999/);
    expect(world.station(sink.id)).toBeDefined();
  });

  it('is deterministic', () => {
    const run = () => {
      const { kit, sink } = stationPairLayout(2, 8);
      const world = worldOf(kit);
      for (let t = 0; t < 1500; t++) world.tick();
      return [world.station(sink.id).received(1001), world.belt(1).cargoCells()];
    };
    expect(run()).toEqual(run());
  });
});

describe('World phases', () => {
  it('runs registered entities in the order of MX §10.7, each phase in registration order', () => {
    const { kit } = stationPairLayout(1, 4);
    const world = worldOf(kit);
    const log: string[] = [];
    const phases: Phase[] = ['stationOut', 'belts', 'sorters', 'coaters', 'stationIn', 'machines', 'power'];
    for (const phase of phases) {
      world.addEntity({ tick: () => log.push(`${phase}-1`) }, phase);
      world.addEntity({ tick: () => log.push(`${phase}-2`) }, phase);
    }
    world.tick();
    expect(log).toEqual([
      'power-1', 'power-2',
      'machines-1', 'machines-2',
      'stationIn-1', 'stationIn-2',
      'sorters-1', 'sorters-2',
      'belts-1', 'belts-2',
      'coaters-1', 'coaters-2',
      'stationOut-1', 'stationOut-2',
    ]);
  });

  it('rejects an unknown phase', () => {
    const world = worldOf(stationPairLayout().kit);
    expect(() => world.addEntity({ tick: () => {} }, 'bogus' as Phase)).toThrow(/phase 'bogus'/);
  });

  it('runs the station input port before the sorters and after the machines', () => {
    const { kit, belt, sink } = stationPairLayout(1, 4);
    const world = worldOf(kit);
    // A cargo resting at the rear of the belt, ready for the sink station.
    const sim = world.belt(belt.id);
    sim.tryInsertAtHead({ item: 1001, stack: 1, inc: 0 });
    for (let i = 0; i < 200; i++) sim.update();
    expect(sim.leadCell()).toBe(sim.length - 10);
    const seen: Record<string, number> = {};
    const probe = (name: string, phase: Phase) =>
      world.addEntity({ tick: () => { seen[name] = sim.cargoCount() * 10 + world.station(sink.id).received(1001); } }, phase);
    probe('machines', 'machines');
    probe('sorters', 'sorters');
    world.tick();
    expect(seen.machines).toBe(10); // cargo still on the belt, nothing received
    expect(seen.sorters).toBe(1); // consumed by the input port in between
  });

  it('updates belts after the sorters and writes station output last', () => {
    const { kit, source } = stationPairLayout(3, 4);
    const world = worldOf(kit);
    const emitted = () => world.station(source.id).emitted(1001);
    const afterBelts: number[] = [];
    const afterOut: number[] = [];
    world.addEntity({ tick: () => afterBelts.push(emitted()) }, 'belts');
    world.addEntity({ tick: () => afterOut.push(emitted()) }, 'stationOut');
    for (let t = 0; t < 3; t++) world.tick();
    // The port writes at tick 0, rests at tick 1 and writes again at tick 2 once the belt has moved the first
    // cargo off the head.
    expect(afterBelts).toEqual([0, 1, 1]);
    expect(afterOut).toEqual([1, 1, 2]);
  });
});

describe('World power', () => {
  it('has ratio 1 with no supply cap, whatever the demand', () => {
    const { kit } = stationPairLayout();
    const world = worldOf(kit);
    world.addEntity({ tick: () => world.addPowerDemand(1e9) }, 'machines');
    for (let t = 0; t < 5; t++) {
      world.tick();
      expect(world.powerRatio).toBe(1);
    }
  });

  it('caps the ratio at supply / last tick demand', () => {
    const { kit } = stationPairLayout();
    // 600 W = 10 J/tick; the machine asks for 20 J/tick.
    const world = worldOf(kit, {}, { powerSupplyW: 600 });
    let demand = 20;
    const seen: number[] = [];
    world.addEntity({ tick: () => { seen.push(world.powerRatio); world.addPowerDemand(demand); } }, 'machines');
    world.tick(); // no demand recorded yet
    world.tick();
    world.tick();
    demand = 5;
    world.tick(); // still sees the last tick's demand of 20
    world.tick(); // demand was 5
    demand = 10;
    world.tick();
    expect(seen).toEqual([1, 0.5, 0.5, 0.5, 1, 1]);
    expect(world.powerRatio).toBe(1);
  });

  it('adds up the demand of every entity in a tick', () => {
    const { kit } = stationPairLayout();
    const world = worldOf(kit, {}, { powerSupplyW: 600 });
    for (const j of [10, 10, 20]) world.addEntity({ tick: () => world.addPowerDemand(j) }, 'sorters');
    world.tick();
    world.tick();
    expect(world.powerRatio).toBeCloseTo(10 / 40, 12);
  });
});
