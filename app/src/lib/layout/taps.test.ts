import { describe, expect, it } from 'vitest';
import { buildingDef, buildingOBBs, LEVEL, pointInOBBs, portInfos, slotInfos, sorterEndsValid, sorterTapEnds, sorterTapPoint, TILE } from '../geometry';
import type { PlacedBuilding, Yaw } from '../geometry';
import { checkCapacity, sorterRate } from '../validate/capacity';
import { fixtureData, patchBuilding, planOf, planStage } from '../validate/testkit';
import { netStack } from './netlist';
import type { Netlist } from './netlist';
import { constructivePlacement, placementBuildingIdOf, stationBuildingId } from './placement';
import type { Placement } from './placement';
import { defaultRouteParams, routeNets } from './router';
import { assignTaps } from './taps';
import type { AssignedTap, TapAssignment } from './taps';
import {
  ASSEMBLER,
  BlockingOccupancy,
  data,
  effects,
  layoutOf,
  occupancyOf,
  PLS,
  processorNetlist,
  spanOnePoints,
  synthNetlist,
} from './testkit';

const REFINERY = 2308;
const SMELTER = 2302;
const COLLIDER = 2310;

/** One machine of `itemId` at the origin, in a placement that holds only it. */
function lone(itemId: number): { buildings: PlacedBuilding[]; placement: Placement } {
  const b: PlacedBuilding = { id: placementBuildingIdOf(1), itemId, x: 0, y: 0, z: 0, yaw: 0, recipeId: 100, role: 'stage:0' };
  return { buildings: [b], placement: { buildings: [b], cost: 0 } };
}

const key = (x: number, y: number): string => `${x},${y}`;
/** The lattice points a tap needs on the ground: the tap point and the nodes before and after it along its axis. */
const needed = (t: AssignedTap): string[] =>
  [-1, 0, 1].map((k) => key(t.point.x + (t.axis === 'x' ? k : 0), t.point.y + (t.axis === 'y' ? k : 0)));

function ok(r: TapAssignment | { failed: string }): TapAssignment {
  if ('failed' in r) throw new Error(`assignTaps failed: ${r.failed}`);
  return r;
}

describe('assignTaps on the constructive Processor placement (margin 2)', () => {
  it('gives every netlist tap enough sorters on distinct slots, with room to route', async () => {
    const net: Netlist = await processorNetlist();
    const placement = constructivePlacement(net, data, 2);
    const occ = occupancyOf(placement.buildings);
    const res = ok(assignTaps(net, placement, occ, data, effects));
    const byId = new Map(placement.buildings.map((b) => [b.id, b]));

    // one slot, one sorter
    const slots = new Set<string>();
    for (const t of res.taps) {
      const k = `${t.machineId}:${t.slot}`;
      expect(slots.has(k), `slot ${k} is used twice`).toBe(false);
      slots.add(k);
    }

    for (const n of net.nets) {
      const stack = netStack(n.source.kind === 'station', effects);
      for (const tap of n.taps) {
        const mine = res.taps.filter((t) => t.netId === n.id && t.machineId === tap.machineId && t.dir === tap.dir);
        expect(mine.length, `net ${n.id} machine ${tap.machineId}`).toBeGreaterThanOrEqual(1);
        expect(mine.map((t) => t.sorterIndex)).toEqual(mine.map((_, i) => i));
        const total = mine.reduce((s, t) => s + t.rate, 0);
        expect(total).toBeGreaterThanOrEqual(tap.rate * (1 - 1e-9));
        for (const t of mine) {
          const cap = sorterRate(net.sorterTierItemId, t.span, tap.dir === 'in' ? stack : 0, effects, data);
          expect(t.rate).toBeLessThanOrEqual(cap * (1 + 1e-9));
          // a span-1 count is a lower bound on the count
          expect(mine.length).toBeGreaterThanOrEqual(1);
        }
        if (mine.every((t) => t.span === 1)) expect(mine.length).toBe(tap.sorters);
      }
    }

    // tap points are real lattice points of the slot, off every building and free for belts
    const allObbs = placement.buildings.flatMap((b) => buildingOBBs(b, buildingDef(data, b.itemId)));
    for (const t of res.taps) {
      const b = byId.get(placementBuildingIdOf(t.machineId)) as PlacedBuilding;
      const info = slotInfos(b, buildingDef(data, b.itemId))[t.slot];
      expect(t.point).toEqual(sorterTapPoint(info, t.span));
      expect(t.axis).toBe(info.dir[0] !== 0 ? 'y' : 'x');
      expect(pointInOBBs(t.point.x, t.point.y, null, allObbs, 0), `tap ${JSON.stringify(t)} in a building`).toBe(false);
      expect(occ.blockedForBelt(t.point.x, t.point.y, 0), `tap ${JSON.stringify(t)} blocked`).toBe(false);
    }

    // the ground a tap needs (itself and the nodes before and after it) is not another net's
    const owner = new Map<string, { net: number; axis: string }>();
    for (const t of res.taps) {
      for (const c of needed(t)) {
        const o = owner.get(c);
        if (o) {
          expect(o.net, `cell ${c} is needed by nets ${o.net} and ${t.netId}`).toBe(t.netId);
          expect(o.axis).toBe(t.axis);
        }
        owner.set(c, { net: t.netId, axis: t.axis });
      }
    }
  });

  it('gives each station end of a net one port of its station, at the port first lattice point outside', async () => {
    const net = await processorNetlist();
    const placement = constructivePlacement(net, data, 2);
    const res = ok(assignTaps(net, placement, occupancyOf(placement.buildings), data, effects));

    const expected: { netId: number; end: 'source' | 'sink'; idx: number }[] = [];
    for (const n of net.nets) {
      if (n.source.kind === 'station') expected.push({ netId: n.id, end: 'source', idx: n.source.stationIdx });
      if (n.sink.kind === 'station') expected.push({ netId: n.id, end: 'sink', idx: n.sink.stationIdx });
    }
    expect(expected.length).toBeGreaterThan(0);
    expect(res.stationPorts).toHaveLength(expected.length);
    const used = new Set<string>();
    for (const e of expected) {
      const p = res.stationPorts.find((x) => x.netId === e.netId && x.end === e.end);
      expect(p, `net ${e.netId} ${e.end}`).toBeDefined();
      expect(p!.stationBuildingId).toBe(stationBuildingId(e.idx));
      const k = `${p!.stationBuildingId}:${p!.port}`;
      expect(used.has(k), `port ${k} used twice`).toBe(false);
      used.add(k);
      const st = placement.buildings.find((b) => b.id === p!.stationBuildingId) as PlacedBuilding;
      const info = portInfos(st, buildingDef(data, st.itemId))[p!.port];
      expect(p!.point).toEqual(info.firstOutside);
      expect(p!.dir).toEqual(info.dir);
    }
  });

  it('is deterministic', async () => {
    const net = await processorNetlist();
    const placement = constructivePlacement(net, data, 2);
    const a = assignTaps(net, placement, occupancyOf(placement.buildings), data, effects);
    const b = assignTaps(net, placement, occupancyOf(placement.buildings), data, effects);
    expect(a).toEqual(b);
  });
});

describe('assignTaps spans', () => {
  const oneTap = (rate: number, dir: 'in' | 'out' = 'out'): Netlist =>
    synthNetlist(
      [{ building: ASSEMBLER, count: 1 }],
      [],
      [{ taps: [{ machineId: 1, itemId: 1001, dir, rate, sorters: 1 }], rate }],
      2011,
    );

  it('uses span 1 when it can', () => {
    const { buildings, placement } = lone(ASSEMBLER);
    const res = ok(assignTaps(oneTap(1.0), placement, occupancyOf(buildings), data, effects));
    expect(res.taps).toHaveLength(1);
    expect(res.taps[0].span).toBe(1);
    expect(res.taps[0].rate).toBeCloseTo(1.0, 9);
  });

  it('a span-2 choice raises the sorter count when one span-2 sorter cannot carry the rate', () => {
    const { buildings, placement } = lone(ASSEMBLER);
    // Mk.I from a building: 1.5/s at span 1, 0.75/s at span 2
    expect(sorterRate(2011, 1, 0, effects, data)).toBeCloseTo(1.5, 9);
    expect(sorterRate(2011, 2, 0, effects, data)).toBeCloseTo(0.75, 9);
    const occ = new BlockingOccupancy(buildings, spanOnePoints(buildings[0]));
    const res = ok(assignTaps(oneTap(1.0), placement, occ, data, effects));
    expect(res.taps).toHaveLength(2);
    for (const t of res.taps) {
      expect(t.span).toBe(2);
      expect(t.rate).toBeLessThanOrEqual(0.75 * (1 + 1e-9));
    }
    expect(res.taps.reduce((s, t) => s + t.rate, 0)).toBeCloseTo(1.0, 9);
    expect(new Set(res.taps.map((t) => t.slot)).size).toBe(2);
    // the sorters are listed in order
    expect(res.taps.map((t) => t.sorterIndex)).toEqual([0, 1]);
  });

  it('falls back to span 3 when spans 1 and 2 are blocked', () => {
    const { buildings, placement } = lone(ASSEMBLER);
    const info = slotInfos(buildings[0], buildingDef(data, ASSEMBLER));
    const blocked = info.flatMap((s) => [sorterTapPoint(s, 1), sorterTapPoint(s, 2)]);
    const res = ok(assignTaps(oneTap(0.5), placement, new BlockingOccupancy(buildings, blocked), data, effects));
    expect(res.taps.every((t) => t.span === 3)).toBe(true);
    expect(res.taps.reduce((s, t) => s + t.rate, 0)).toBeCloseTo(0.5, 9);
  });

  it('counts sorters picking from a belt at the belt stack, not as building picks', () => {
    const { buildings, placement } = lone(ASSEMBLER);
    // Mk.I from a stack-1 belt carries 1 item per trip, as from a building: still 1.5/s at span 1
    const res = ok(assignTaps(oneTap(1.4, 'in'), placement, occupancyOf(buildings), data, effects));
    expect(res.taps).toHaveLength(1);
    expect(res.taps[0].dir).toBe('in');
  });

  it('allocates more slots when the rate needs them', () => {
    const { buildings, placement } = lone(ASSEMBLER);
    const res = ok(assignTaps(oneTap(4.0), placement, occupancyOf(buildings), data, effects));
    // 4.0 / 1.5 -> 3 sorters at span 1
    expect(res.taps).toHaveLength(3);
    expect(new Set(res.taps.map((t) => t.slot)).size).toBe(3);
  });
});

describe('assignTaps slot rules', () => {
  it('skips slots whose tap point is blocked for belts by their own building (Oil Refinery north face)', () => {
    const { buildings, placement } = lone(REFINERY);
    const net = synthNetlist(
      [{ building: REFINERY, count: 1 }],
      [],
      [{ taps: [{ machineId: 1, itemId: 1001, dir: 'out', rate: 3, sorters: 2 }], rate: 3 }],
      2011,
    );
    const occ = occupancyOf(buildings);
    // premise: the refinery north slots' first lattice point outside is blocked for belts
    const info = slotInfos(buildings[0], buildingDef(data, REFINERY));
    expect(occ.blockedForBelt(info[1].firstOutside.x, info[1].firstOutside.y, 0)).toBe(true);
    const res = ok(assignTaps(net, placement, occ, data, effects));
    expect(res.taps.length).toBeGreaterThanOrEqual(2);
    for (const t of res.taps) {
      expect(occ.blockedForBelt(t.point.x, t.point.y, 0)).toBe(false);
      if (t.slot <= 2) expect(t.span).toBeGreaterThanOrEqual(2);
    }
    // span-1 slots exist elsewhere, so none of the north slots is used at span 1
    expect(res.taps.filter((t) => t.slot <= 2 && t.span === 1)).toEqual([]);
  });

  it('prefers slots facing the other taps of the net', () => {
    const net = synthNetlist(
      [{ building: ASSEMBLER, count: 2 }],
      [],
      [
        {
          taps: [
            { machineId: 1, itemId: 1001, dir: 'out', rate: 0.5, sorters: 1 },
            { machineId: 2, itemId: 1001, dir: 'in', rate: 0.5, sorters: 1 },
          ],
        },
      ],
    );
    const a: PlacedBuilding = { id: placementBuildingIdOf(1), itemId: ASSEMBLER, x: 0, y: 0, z: 0, yaw: 0 };
    const b: PlacedBuilding = { id: placementBuildingIdOf(2), itemId: ASSEMBLER, x: 20, y: 0, z: 0, yaw: 0 };
    const placement: Placement = { buildings: [a, b], cost: 0 };
    const res = ok(assignTaps(net, placement, occupancyOf([a, b]), data, effects));
    const fromA = res.taps.find((t) => t.machineId === 1) as AssignedTap;
    const fromB = res.taps.find((t) => t.machineId === 2) as AssignedTap;
    const infoA = slotInfos(a, buildingDef(data, ASSEMBLER))[fromA.slot];
    const infoB = slotInfos(b, buildingDef(data, ASSEMBLER))[fromB.slot];
    expect(infoA.dir).toEqual([1, 0]);
    expect(infoB.dir).toEqual([-1, 0]);
  });

  it('gives two taps of the same item from different nets distinct slots and keeps their ground apart', () => {
    const tap = (dir: 'in' | 'out') => ({ machineId: 1, itemId: 1001, dir, rate: 0.5, sorters: 1 });
    const net = synthNetlist([{ building: SMELTER, count: 1 }], [], [{ taps: [tap('out')] }, { taps: [tap('out')] }]);
    const { buildings, placement } = lone(SMELTER);
    const res = ok(assignTaps(net, placement, occupancyOf(buildings), data, effects));
    expect(res.taps).toHaveLength(2);
    expect(res.taps[0].slot).not.toBe(res.taps[1].slot);
    const [a, b] = res.taps.map(needed);
    expect(a.filter((c) => b.includes(c))).toEqual([]);
  });

  it('fails with a message naming the machine when it runs out of slots', () => {
    const { buildings, placement } = lone(SMELTER);
    const net = synthNetlist(
      [{ building: SMELTER, count: 1 }],
      [],
      [{ taps: [{ machineId: 1, itemId: 1001, dir: 'out', rate: 100, sorters: 67 }], rate: 100 }],
    );
    const res = assignTaps(net, placement, occupancyOf(buildings), data, effects);
    expect(res).toHaveProperty('failed');
    expect((res as { failed: string }).failed).toMatch(/machine 1/);
    expect((res as { failed: string }).failed).toMatch(/slot/);
  });

  describe('poses that do not face along an axis', () => {
    const skewRotation: [number, number, number, number] = [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)];
    const twoMachines = (rate: number) =>
      synthNetlist(
        [{ building: ASSEMBLER, count: 2 }],
        [],
        [
          {
            taps: [
              { machineId: 1, itemId: 1001, dir: 'out', rate, sorters: 1 },
              { machineId: 2, itemId: 1001, dir: 'in', rate, sorters: 1 },
            ],
          },
        ],
      );
    const eastWest = (): { buildings: PlacedBuilding[]; placement: Placement } => {
      const a: PlacedBuilding = { id: placementBuildingIdOf(1), itemId: ASSEMBLER, x: 0, y: 0, z: 0, yaw: 0 };
      const b: PlacedBuilding = { id: placementBuildingIdOf(2), itemId: ASSEMBLER, x: 20, y: 0, z: 0, yaw: 0 };
      return { buildings: [a, b], placement: { buildings: [a, b], cost: 0 } };
    };

    it('leave out only that slot: the others of the building still work', () => {
      const patched = patchBuilding(fixtureData, ASSEMBLER, (b) => ({
        ...b,
        geometry: { ...b.geometry, slots: b.geometry.slots.map((s, i) => (i === 3 ? { ...s, rotation: skewRotation } : s)) },
      }));
      // premise: the slots of the building cannot be read as a whole any more
      const a = eastWest().buildings[0];
      expect(() => slotInfos(a, buildingDef(patched, ASSEMBLER))).toThrow(/axis/);
      const { buildings, placement } = eastWest();
      // 4.0/s needs three Mk.I sorters at span 1, and the east face (slots 3, 4, 5) is the favourite
      const res = ok(assignTaps(twoMachines(4.0), placement, occupancyOf(buildings), patched, effects));
      const mine = res.taps.filter((t) => t.machineId === 1);
      expect(mine).toHaveLength(3);
      expect(mine.map((t) => t.slot)).not.toContain(3);
      expect(mine.map((t) => t.slot)).toEqual(expect.arrayContaining([4, 5]));
    });

    it('make the building fail only when none is left, naming the cause', () => {
      const patched = patchBuilding(fixtureData, ASSEMBLER, (b) => ({
        ...b,
        geometry: { ...b.geometry, slots: b.geometry.slots.map((s) => ({ ...s, rotation: skewRotation })) },
      }));
      const { buildings, placement } = eastWest();
      const res = assignTaps(twoMachines(0.5), placement, occupancyOf(buildings), patched, effects);
      expect(res).toHaveProperty('failed');
      expect((res as { failed: string }).failed).toMatch(/machine 1/);
      expect((res as { failed: string }).failed).toMatch(/none of its sorter slots/);
      expect((res as { failed: string }).failed).toMatch(/axis/);
    });

    it('name the skew slots when a machine runs out of the others', () => {
      const patched = patchBuilding(fixtureData, ASSEMBLER, (b) => ({
        ...b,
        geometry: { ...b.geometry, slots: b.geometry.slots.map((s, i) => (i < 11 ? { ...s, rotation: skewRotation } : s)) },
      }));
      const { buildings, placement } = eastWest();
      const res = assignTaps(twoMachines(4.0), placement, occupancyOf(buildings), patched, effects);
      expect(res).toHaveProperty('failed');
      expect((res as { failed: string }).failed).toMatch(/11 more do not face along an axis/);
    });

    it('leave out only that port of a station', () => {
      const patched = patchBuilding(fixtureData, PLS, (b) => ({
        ...b,
        geometry: { ...b.geometry, ports: b.geometry.ports.map((p, i) => (i === 10 ? { ...p, rotation: skewRotation } : p)) },
      }));
      const net = synthNetlist(
        [{ building: ASSEMBLER, count: 1 }],
        [PLS],
        [{ source: { kind: 'station', stationIdx: 0 }, taps: [{ machineId: 1, itemId: 1001, dir: 'in', rate: 0.5, sorters: 1 }] }],
      );
      const station: PlacedBuilding = { id: stationBuildingId(0), itemId: PLS, x: 0, y: 0, z: 0, yaw: 0, role: 'station:0' };
      const m: PlacedBuilding = { id: placementBuildingIdOf(1), itemId: ASSEMBLER, x: 30, y: 0, z: 0, yaw: 0 };
      const occ = occupancyOf([station, m]);
      const plain = ok(assignTaps(net, { buildings: [station, m], cost: 0 }, occ, data, effects));
      expect(plain.stationPorts[0].port).toBe(10);
      const res = ok(assignTaps(net, { buildings: [station, m], cost: 0 }, occ, patched, effects));
      expect(res.stationPorts).toHaveLength(1);
      expect(res.stationPorts[0].port).not.toBe(10);
    });
  });

  it('keeps the producers and consumers of a net apart on a row, so no consumer sits upstream of a producer', () => {
    // facing machines with a one-lattice-line gap: their favourite slots meet on the same row
    const a: PlacedBuilding = { id: placementBuildingIdOf(1), itemId: ASSEMBLER, x: 0, y: 0, z: 0, yaw: 0 };
    const b: PlacedBuilding = { id: placementBuildingIdOf(2), itemId: ASSEMBLER, x: 4, y: 0, z: 0, yaw: 0 };
    const net = synthNetlist(
      [{ building: ASSEMBLER, count: 2 }],
      [],
      [
        {
          taps: [
            { machineId: 1, itemId: 1001, dir: 'out', rate: 0.5, sorters: 1 },
            { machineId: 2, itemId: 1001, dir: 'in', rate: 0.5, sorters: 1 },
          ],
        },
      ],
    );
    const res = ok(assignTaps(net, { buildings: [a, b], cost: 0 }, occupancyOf([a, b]), data, effects));
    const out = res.taps.filter((t) => t.dir === 'out');
    const inn = res.taps.filter((t) => t.dir === 'in');
    expect(out.length).toBeGreaterThan(0);
    expect(inn.length).toBeGreaterThan(0);
    for (const p of out) {
      for (const c of inn) {
        const sameRow = p.axis === c.axis && (p.axis === 'x' ? p.point.y === c.point.y : p.point.x === c.point.x);
        const apart = p.axis === 'x' ? Math.abs(p.point.x - c.point.x) : Math.abs(p.point.y - c.point.y);
        expect(!sameRow || apart > 2, `producer ${JSON.stringify(p.point)} and consumer ${JSON.stringify(c.point)}`).toBe(true);
      }
    }
  });

  it('fails when a station has no free port', () => {
    const net = synthNetlist(
      [{ building: ASSEMBLER, count: 1 }],
      [PLS],
      Array.from({ length: 13 }, () => ({
        source: { kind: 'station' as const, stationIdx: 0 },
        taps: [{ machineId: 1, itemId: 1001, dir: 'in' as const, rate: 0.01, sorters: 1 }],
      })),
    );
    const station: PlacedBuilding = { id: stationBuildingId(0), itemId: PLS, x: 0, y: 0, z: 0, yaw: 0, role: 'station:0' };
    const m: PlacedBuilding = { id: placementBuildingIdOf(1), itemId: ASSEMBLER, x: 30, y: 0, z: 0, yaw: 0 };
    const res = assignTaps(net, { buildings: [station, m], cost: 0 }, occupancyOf([station, m]), data, effects);
    expect(res).toHaveProperty('failed');
    expect((res as { failed: string }).failed).toMatch(/port/);
  });
});

describe('assignTaps sorter ends (the validator\'s SORTER_SPAN and SORTER_SKEW rules)', () => {
  const REACH = data.data.constants.sorterMaxReachMeters;
  const at = (itemId: number, x: number, y: number, yaw: Yaw): { buildings: PlacedBuilding[]; placement: Placement } => {
    const b: PlacedBuilding = { id: placementBuildingIdOf(1), itemId, x, y, z: 0, yaw, recipeId: 100, role: 'stage:0' };
    return { buildings: [b], placement: { buildings: [b], cost: 0 } };
  };
  const tapNet = (building: number, dir: 'in' | 'out', rate: number): Netlist =>
    synthNetlist([{ building, count: 1 }], [], [{ taps: [{ machineId: 1, itemId: 1001, dir, rate, sorters: 1 }], rate }], 2011);

  /** The sorter's length in metres, worked out from the slot and the tap point alone (not through the shared predicate). */
  function lengthOf(t: AssignedTap, b: PlacedBuilding): number {
    const slot = slotInfos(b, buildingDef(data, b.itemId))[t.slot];
    const along = t.axis === 'y' ? t.point.x - slot.pos.x : t.point.y - slot.pos.y; // across the belt: the facing direction
    return Math.hypot(along * TILE, slot.pos.z * LEVEL); // the belt end sits at the slot's own lateral coordinate, on the ground
  }

  const validAtSpanOne = (b: PlacedBuilding, slot: number): boolean => {
    const s = slotInfos(b, buildingDef(data, b.itemId))[slot];
    return sorterEndsValid({ ...sorterTapEnds(s, sorterTapPoint(s, 1), 'out'), facings: [s.dir], toBelt: true }, REACH);
  };

  it('a Miniature Particle Collider never gets a sorter shorter than 1 m, at any yaw and lattice offset', () => {
    let configsWithShortSpanOne = 0;
    for (const yaw of [0, 90, 180, 270] as Yaw[]) {
      for (const [x, y] of [[0, 0], [0.25, 0.25], [0.5, 0], [0, 0.5], [0.5, 0.5], [0.75, 0.1], [0.1, 0.9], [0.7, 0.7]]) {
        const { buildings, placement } = at(COLLIDER, x, y, yaw);
        const b = buildings[0];
        if (Array.from({ length: 9 }, (_, i) => i).some((i) => !validAtSpanOne(b, i))) configsWithShortSpanOne++;
        for (const dir of ['out', 'in'] as const) {
          // 4 Mk.I sorters at span 1 (the 9 slots at span 2 still carry 6.75 / s)
          const res = ok(assignTaps(tapNet(COLLIDER, dir, 6), placement, occupancyOf(buildings), data, effects));
          for (const t of res.taps) {
            const label = `yaw ${yaw} at (${x}, ${y}) ${dir} slot ${t.slot} span ${t.span}`;
            expect(lengthOf(t, b), label).toBeGreaterThanOrEqual(1 - 1e-9);
            const slot = slotInfos(b, buildingDef(data, COLLIDER))[t.slot];
            expect(sorterEndsValid({ ...sorterTapEnds(slot, t.point, t.dir), facings: [slot.dir], toBelt: true }, REACH), label).toBe(true);
          }
        }
      }
    }
    // the premise: the collider has placements where a span-1 sorter on some slot would be too short
    expect(configsWithShortSpanOne).toBeGreaterThan(0);
  });

  it('a collider tap whose span 1 is too short takes span 2 on the same slot (origin, yaw 0: the east slots 3-5)', () => {
    const { buildings, placement } = at(COLLIDER, 0, 0, 0);
    const infos = slotInfos(buildings[0], buildingDef(data, COLLIDER));
    // premise: the east face is 0.618 tile from the first lattice point outside, so a span-1 sorter is 0.777 m long
    for (const i of [3, 4, 5]) expect(infos[i].firstOutside.x - infos[i].pos.x).toBeCloseTo(0.618, 2);
    // only the east slots are left: the other faces' tap points are blocked
    const blocked = infos.flatMap((s) => (s.index >= 3 && s.index <= 5 ? [] : [1, 2, 3].map((span) => sorterTapPoint(s, span as 1 | 2 | 3))));
    const res = ok(assignTaps(tapNet(COLLIDER, 'out', 1), placement, new BlockingOccupancy(buildings, blocked), data, effects));
    expect(res.taps.length).toBeGreaterThan(0);
    for (const t of res.taps) {
      expect(t.slot).toBeGreaterThanOrEqual(3);
      expect(t.slot).toBeLessThanOrEqual(5);
      expect(t.span, `slot ${t.slot}`).toBeGreaterThanOrEqual(2);
    }
    expect(res.taps.reduce((sum, t) => sum + t.rate, 0)).toBeCloseTo(1, 9);
  });

  it('fails with the usual message when the only choices left would make a sorter the validator rejects', () => {
    const { buildings, placement } = at(COLLIDER, 0, 0, 0);
    const infos = slotInfos(buildings[0], buildingDef(data, COLLIDER));
    // the east slots keep their span-1 tap points (too short) and lose spans 2 and 3; the other faces lose all
    const blocked = infos.flatMap((s) => {
      const spans = s.index >= 3 && s.index <= 5 ? [2, 3] : [1, 2, 3];
      return spans.map((span) => sorterTapPoint(s, span as 1 | 2 | 3));
    });
    const res = assignTaps(tapNet(COLLIDER, 'out', 1), placement, new BlockingOccupancy(buildings, blocked), data, effects);
    expect(res).toHaveProperty('failed');
    expect((res as { failed: string }).failed).toMatch(/no usable sorter slot/);
  });

  it('leaves an assembler as before: span 1 on every slot it needs', () => {
    const { buildings, placement } = at(ASSEMBLER, 0, 0, 0);
    const res = ok(assignTaps(tapNet(ASSEMBLER, 'out', 4), placement, occupancyOf(buildings), data, effects));
    expect(res.taps.every((t) => t.span === 1)).toBe(true);
  });
});

describe('assignTaps with the internal sorters of motifs', () => {
  it('leaves the slots they use to them: the tap takes another slot, on both machines', () => {
    const { placement } = lone(ASSEMBLER);
    const tap = { machineId: 1, itemId: 1001, dir: 'in' as const, rate: 1, sorters: 1 };
    const net: Netlist = synthNetlist([{ building: ASSEMBLER, count: 1 }], [], [{ taps: [tap] }]);
    const occ = occupancyOf(placement.buildings);
    const plain = ok(assignTaps(net, placement, occ, data, effects));
    const taken = plain.taps[0].slot;

    const internal = (fromMachine: number, fromSlot: number, toMachine: number, toSlot: number) => ({
      fromMachine, fromSlot, toMachine, toSlot, itemId: 1101, span: 1 as const, plannedRate: 1,
    });
    // the tap's slot is the sorter's drop slot...
    const asDrop: Netlist = { ...net, motifs: { groups: [], sorters: [internal(2, 0, 1, taken)] } };
    expect(ok(assignTaps(asDrop, placement, occ, data, effects)).taps.map((t) => t.slot)).not.toContain(taken);
    // ...or its pick slot
    const asPick: Netlist = { ...net, motifs: { groups: [], sorters: [internal(1, taken, 2, 0)] } };
    expect(ok(assignTaps(asPick, placement, occ, data, effects)).taps.map((t) => t.slot)).not.toContain(taken);
    // a sorter on another machine's slot does not matter
    const elsewhere: Netlist = { ...net, motifs: { groups: [], sorters: [internal(2, taken, 3, taken)] } };
    expect(ok(assignTaps(elsewhere, placement, occ, data, effects))).toEqual(plain);
  });

  it('fails the usual way when the internal sorters leave a machine too few slots', () => {
    const { placement } = lone(ASSEMBLER);
    const tap = { machineId: 1, itemId: 1001, dir: 'in' as const, rate: 1, sorters: 1 };
    const net: Netlist = synthNetlist([{ building: ASSEMBLER, count: 1 }], [], [{ taps: [tap] }]);
    const all = Array.from({ length: 12 }, (_, slot) => ({
      fromMachine: 2, fromSlot: 0, toMachine: 1, toSlot: slot, itemId: 1101, span: 1 as const, plannedRate: 1,
    }));
    const res = assignTaps({ ...net, motifs: { groups: [], sorters: all } }, placement, occupancyOf(placement.buildings), data, effects);
    expect(res).toHaveProperty('failed');
    expect((res as { failed: string }).failed).toMatch(/no usable sorter slot/);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 27: multi-lane taps (MX §9 M2: several belts side by side along one face of a machine; a sorter of span 2 or 3
// reaches a farther lane over the nearer ones)

describe('assignTaps multi-lane taps (MX §9 M2)', () => {
  const MAGNET = 1102;
  const COPPER = 1104;

  /** One assembler at the origin; only its east face (slots 3, 4, 5, facing east) has tap points a belt can use. */
  function eastFaceOnly(): { buildings: PlacedBuilding[]; placement: Placement; occ: BlockingOccupancy; east: ReturnType<typeof slotInfos> } {
    const { buildings, placement } = lone(ASSEMBLER);
    const infos = slotInfos(buildings[0], buildingDef(data, ASSEMBLER));
    const east = infos.filter((s) => s.index >= 3 && s.index <= 5);
    for (const s of east) expect(s.dir).toEqual([1, 0]);
    const blocked = infos.flatMap((s) => (s.index >= 3 && s.index <= 5 ? [] : [1, 2, 3].map((span) => sorterTapPoint(s, span as 1 | 2 | 3))));
    return { buildings, placement, occ: new BlockingOccupancy(buildings, blocked), east };
  }

  /** Nets of one input each (items `items[i]` at `rates[i]`) tapping machine 1, in this order. */
  const inputNets = (rates: number[], items = [MAGNET, COPPER, 1103]): Netlist =>
    synthNetlist(
      [{ building: ASSEMBLER, count: 1 }],
      [],
      rates.map((rate, i) => ({ itemId: items[i], rate, taps: [{ machineId: 1, itemId: items[i], dir: 'in' as const, rate, sorters: 1 }] })),
      2011,
    );

  const tapsOf = (res: TapAssignment, netId: number): AssignedTap[] => res.taps.filter((t) => t.netId === netId);
  const sum = (taps: AssignedTap[]): number => taps.reduce((s, t) => s + t.rate, 0);

  /** The layout the taps make once routed, judged by the rate checks the solver relies on. */
  function capacityOf(net: Netlist, placement: Placement, res: TapAssignment, occ: BlockingOccupancy, inputs: number[], items: number[]) {
    const routed = routeNets(net, res, occ, defaultRouteParams(occ), () => false);
    expect(routed.ok, 'the nets route').toBe(true);
    if (!routed.ok) return [];
    const layout = layoutOf(net, placement, res, routed.routes);
    const plan = planOf([planStage(100, { inputs: inputs.map((perSecond, i) => ({ itemId: items[i], perSecond })) })]);
    return checkCapacity(layout, plan, data, effects);
  }

  it('regression, true before Task 27 too: when the span-1 tap point of one net lies on the ground of another, that net takes span 2 on a slot facing the same way', () => {
    const { placement, occ } = eastFaceOnly();
    // Mk.I sorters from a belt: 1.5/s at span 1, 0.75/s at span 2. Net 1 fills a span-1 lane; net 2 needs 0.5/s.
    const net = inputNets([1.0, 0.5]);
    const res = ok(assignTaps(net, placement, occ, data, effects));
    const first = tapsOf(res, 1);
    const second = tapsOf(res, 2);
    expect(first.map((t) => t.span)).toEqual([1]);
    expect(second).toHaveLength(1);
    expect(second[0].span).toBe(2);
    // the same facing: the lane one further out along the east direction
    expect(second[0].point.x).toBe(first[0].point.x + 1);
    expect(second[0].axis).toBe(first[0].axis);
    // distinct slots, and the ground of the two nets is apart
    expect(second[0].slot).not.toBe(first[0].slot);
    expect(needed(first[0]).filter((c) => needed(second[0]).includes(c))).toEqual([]);
    // the sorter rate covers the tap rate
    expect(sum(second)).toBeCloseTo(0.5, 9);
    expect(second[0].rate).toBeLessThanOrEqual(sorterRate(2011, 2, 1, effects, data) * (1 + 1e-9));
    // it is the slot-by-slot span fallback, not the demand repass: the same without it
    expect(assignTaps(net, placement, occ, data, effects, { repass: false })).toEqual(res);
  });

  it('adds sorters when one span-2 sorter cannot carry the rate of the net on the farther lane, and the layout passes checkCapacity', () => {
    const { placement, occ } = eastFaceOnly();
    // net 1 (1.5/s, one span-1 sorter) covers the ground of the whole face; net 2 needs 1.4/s on the next lane: two span-2 sorters (0.75/s each)
    const net = inputNets([1.5, 1.4]);
    const res = ok(assignTaps(net, placement, occ, data, effects));
    expect(tapsOf(res, 1)).toHaveLength(1);
    const far = tapsOf(res, 2);
    expect(far.map((t) => t.span)).toEqual([2, 2]);
    expect(new Set(far.map((t) => t.slot)).size).toBe(2);
    expect(sum(far)).toBeCloseTo(1.4, 9);
    for (const t of far) expect(t.rate).toBeLessThanOrEqual(0.75 * (1 + 1e-9));
    expect(capacityOf(net, placement, res, occ, [1.5, 1.4], [MAGNET, COPPER])).toEqual([]);
  });

  it('puts the net with the most demanding tap on the nearest lane, whatever its place in the netlist', () => {
    const { placement, occ } = eastFaceOnly();
    // net 1 is a trickle listed first; net 2 needs 3/s, two span-1 sorters. In netlist order the trickle would take a
    // slot at span 1, net 2 would be left with span 2 on the others, and the face would run out of slots.
    const net = inputNets([0.2, 3.0]);
    const res = ok(assignTaps(net, placement, occ, data, effects));
    const heavy = tapsOf(res, 2);
    expect(heavy.map((t) => t.span)).toEqual([1, 1]);
    expect(sum(heavy)).toBeCloseTo(3.0, 9);
    const light = tapsOf(res, 1);
    expect(light.map((t) => t.span)).toEqual([2]);
    expect(light[0].point.x).toBe(heavy[0].point.x + 1);
    expect(capacityOf(net, placement, res, occ, [0.2, 3.0], [MAGNET, COPPER])).toEqual([]);
    // the repass is what does it: in netlist order the trickle takes a span-1 slot and the heavy net runs out of slots
    const inOrder = assignTaps(net, placement, occ, data, effects, { repass: false });
    expect(inOrder).toHaveProperty('failed');
    expect((inOrder as { failed: string }).failed).toMatch(/net 2: machine 1 .* no usable sorter slot/);
  });

  it('assigns again in order of demand when that needs fewer sorters, though the netlist order succeeds too', () => {
    const { placement, occ } = eastFaceOnly();
    // net 1 is a 0.2/s trickle listed first, net 2 needs 1.5/s: exactly one span-1 sorter
    const net = inputNets([0.2, 1.5]);
    // netlist order: the trickle takes a span-1 lane and net 2 gets two span-2 sorters (0.75/s each): three sorters
    const inOrder = ok(assignTaps(net, placement, occ, data, effects, { repass: false }));
    expect(inOrder.taps.map((t) => [t.netId, t.span])).toEqual([[1, 1], [2, 2], [2, 2]]);
    // demand order: net 2 takes the nearest lane with one sorter and the trickle goes one lane out: two sorters
    const res = ok(assignTaps(net, placement, occ, data, effects));
    expect(res.taps.map((t) => [t.netId, t.span])).toEqual([[1, 2], [2, 1]]); // still in net order
    expect(res.taps.length).toBeLessThan(inOrder.taps.length);
    expect(sum(tapsOf(res, 1))).toBeCloseTo(0.2, 9);
    expect(sum(tapsOf(res, 2))).toBeCloseTo(1.5, 9);
    expect(capacityOf(net, placement, res, occ, [0.2, 1.5], [MAGNET, COPPER])).toEqual([]);
  });

  it('keeps the netlist order when it already needs the fewest sorters and the least span (no change from the repass)', () => {
    const { placement, occ } = eastFaceOnly();
    const net = inputNets([1.5, 0.2]);
    expect(ok(assignTaps(net, placement, occ, data, effects))).toEqual(ok(assignTaps(net, placement, occ, data, effects, { repass: false })));
  });

  it('keeps the netlist order when the demand order does not need fewer sorters or less span', () => {
    const { placement, occ } = eastFaceOnly();
    // 0.3, 0.4 and 0.2/s: three sorters on spans 1, 2 and 3 in either order; the netlist order stands
    const res = ok(assignTaps(inputNets([0.3, 0.4, 0.2]), placement, occ, data, effects));
    expect(res.taps.map((t) => [t.netId, t.span])).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it('returns the taps in net order, then the order of the net\'s taps, whatever order they were assigned in', () => {
    const { placement, occ } = eastFaceOnly();
    const res = ok(assignTaps(inputNets([0.2, 3.0]), placement, occ, data, effects));
    expect(res.taps.map((t) => t.netId)).toEqual([1, 2, 2]);
    expect(res.taps.filter((t) => t.netId === 2).map((t) => t.sorterIndex)).toEqual([0, 1]);
  });

  it('three nets on one face take three lanes, spans 1, 2 and 3, all facing east, and every sorter is one the validator accepts', () => {
    const { buildings, placement, occ } = eastFaceOnly();
    const net = inputNets([0.4, 0.3, 0.2]);
    const res = ok(assignTaps(net, placement, occ, data, effects));
    expect(res.taps).toHaveLength(3);
    // highest demand nearest
    expect(res.taps.map((t) => t.span)).toEqual([1, 2, 3]);
    expect(new Set(res.taps.map((t) => t.axis))).toEqual(new Set(['y']));
    expect(res.taps.map((t) => t.point.x)).toEqual([2, 3, 4]);
    const REACH = data.data.constants.sorterMaxReachMeters;
    const infos = slotInfos(buildings[0], buildingDef(data, ASSEMBLER));
    for (const t of res.taps) {
      const slot = infos[t.slot];
      expect(sorterEndsValid({ ...sorterTapEnds(slot, t.point, t.dir), facings: [slot.dir], toBelt: true }, REACH)).toBe(true);
      expect(t.rate).toBeLessThanOrEqual(sorterRate(2011, t.span, 1, effects, data) * (1 + 1e-9));
    }
    expect(capacityOf(net, placement, res, occ, [0.4, 0.3, 0.2], [MAGNET, COPPER, 1103])).toEqual([]);
  });

  it('a span-2 or span-3 sorter reaches over the lattice points of the nearer lanes, none of which lies inside a building', () => {
    const { buildings, placement, occ } = eastFaceOnly();
    const res = ok(assignTaps(inputNets([0.4, 0.3, 0.2]), placement, occ, data, effects));
    const allObbs = placement.buildings.flatMap((b) => buildingOBBs(b, buildingDef(data, b.itemId)));
    const infos = slotInfos(buildings[0], buildingDef(data, ASSEMBLER));
    for (const t of res.taps) {
      const slot = infos[t.slot];
      for (let k = 0; k < t.span - 1; k++) {
        const x = slot.firstOutside.x + k * slot.dir[0];
        const y = slot.firstOutside.y + k * slot.dir[1];
        expect(pointInOBBs(x, y, null, allObbs, 0), `span ${t.span} passes over (${x}, ${y})`).toBe(false);
      }
    }
  });

  it('a farther lane that is not free is not offered: with the span-2 and span-3 lanes blocked the second net fails the usual way', () => {
    const { placement, buildings, east } = eastFaceOnly();
    const lanes = east.flatMap((s) => [2, 3].map((span) => sorterTapPoint(s, span as 1 | 2 | 3)));
    const blocked = new BlockingOccupancy(buildings, [
      ...lanes,
      ...slotInfos(buildings[0], buildingDef(data, ASSEMBLER)).flatMap((s) => (s.index >= 3 && s.index <= 5 ? [] : [1, 2, 3].map((span) => sorterTapPoint(s, span as 1 | 2 | 3)))),
    ]);
    const res = assignTaps(inputNets([1.0, 0.5]), placement, blocked, data, effects);
    expect(res).toHaveProperty('failed');
    expect((res as { failed: string }).failed).toMatch(/net 2/);
  });
});

describe('assignTaps: the proliferator net (Task 28)', () => {
  it('gives the net one source port on the station that holds the slot, no tap, and takes no other net\'s port', async () => {
    const net = await processorNetlist(1, { tier: 3, mode: 'extra' });
    const feed = net.nets.find((n) => n.proliferator);
    if (!feed || feed.source.kind !== 'station') throw new Error('the netlist has no proliferator net');
    const placement = constructivePlacement(net, data, 3);
    const res = ok(assignTaps(net, placement, occupancyOf(placement.buildings), data, effects));

    expect(res.taps.filter((t) => t.netId === feed.id)).toEqual([]);
    const ports = res.stationPorts.filter((p) => p.netId === feed.id);
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ end: 'source', stationBuildingId: stationBuildingId(feed.source.stationIdx) });
    const taken = res.stationPorts.map((p) => `${p.stationBuildingId}:${p.port}`);
    expect(new Set(taken).size).toBe(taken.length);
    // one port per station end of every net, the feed's included
    const ends = net.nets.reduce((n, x) => n + (x.source.kind === 'station' ? 1 : 0) + (x.sink.kind === 'station' ? 1 : 0), 0);
    expect(res.stationPorts).toHaveLength(ends);
  });

  it('chooses the feed\'s port by where the consumers of the sprayed nets are: a port that faces the machines', async () => {
    const net = await processorNetlist(1, { tier: 3, mode: 'extra' });
    const feed = net.nets.find((n) => n.proliferator);
    if (!feed || feed.source.kind !== 'station') throw new Error('the netlist has no proliferator net');
    const placement = constructivePlacement(net, data, 3);
    const port = ok(assignTaps(net, placement, occupancyOf(placement.buildings), data, effects)).stationPorts.find((p) => p.netId === feed.id);
    // the machines stand east of the column of stations
    expect(port?.dir).toEqual([1, 0]);
  });
});
