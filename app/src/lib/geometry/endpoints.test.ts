import { describe, expect, test } from 'vitest';
import { slotCell } from '../../../scripts/emit-test-blueprint';
import { GameDataIndex } from '../data';
import type { Building, Pose } from '../data';
import { assemblerSorters, loadBlueprintSample } from '../../../test/fixtures/blueprintSamples';
import { loadFixtureGameData } from '../../../test/fixtures/fixtureGameData';
import {
  BELT_HALF_WIDTH_TILES,
  endpointWorld,
  LayoutIndex,
  layoutIndex,
  portInfos,
  slotInfos,
  sorterEnds,
  sorterTapPoint,
} from './endpoints';
import type { BeltPath, Layout, PlacedBuilding, Sorter, Yaw } from './model';
import { TILE } from './transform';

const data = new GameDataIndex(loadFixtureGameData());
const def = (itemId: number): Building => {
  const b = data.building(itemId);
  if (!b) throw new Error(`no building ${itemId}`);
  return b;
};

const ASSEMBLER = 2303;
const ASSEMBLER_MK2 = 2304;
const SMELTER = 2302;
const ILS = 2104;
const YAWS: Yaw[] = [0, 90, 180, 270];

const placed = (itemId: number, x: number, y: number, yaw: Yaw = 0, id = 1): PlacedBuilding => ({ id, itemId, x, y, z: 0, yaw });

const beltOf = (id: number, nodes: [number, number, number?][], over: Partial<BeltPath> = {}): BeltPath => ({
  id,
  tierItemId: 2001,
  itemId: 1001,
  nodes: nodes.map(([x, y, z]) => ({ x, y, z: z ?? 0 })),
  plannedRate: 1,
  ...over,
});

const sorterOf = (over: Partial<Sorter> & Pick<Sorter, 'pick' | 'drop'>): Sorter => ({
  id: 1,
  tierItemId: 2011,
  filterItemId: 0,
  span: 1,
  plannedRate: 1,
  ...over,
});

const layoutOf = (over: Partial<Layout>): Layout => ({
  buildings: [],
  belts: [],
  sorters: [],
  meta: { geometrySource: 'approximate', gameVersion: '0.10.29.22015', planTargetItemId: 1101, planTargetRate: 1 },
  ...over,
});

const M = 1 / TILE;

describe('constants', () => {
  test('belt half width is 0.32 m in tiles', () => {
    expect(BELT_HALF_WIDTH_TILES).toBe(0.32 / TILE);
  });
});

describe('slotInfos', () => {
  const asm = placed(ASSEMBLER, 0, 0);

  test('an assembler has 12 slots, clockwise from the north face\'s west slot', () => {
    const slots = slotInfos(asm, def(ASSEMBLER));
    expect(slots).toHaveLength(12);
    expect(slots.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const faces = slots.map((s) => s.dir.join(','));
    expect(faces).toEqual([
      ...Array(3).fill('0,1'), // north
      ...Array(3).fill('1,0'), // east
      ...Array(3).fill('0,-1'), // south
      ...Array(3).fill('-1,0'), // west
    ]);
    // North face runs west to east, east face north to south.
    expect(slots[0].pos.x).toBeLessThan(slots[2].pos.x);
    expect(slots[3].pos.y).toBeGreaterThan(slots[5].pos.y);
    expect(slots[6].pos.x).toBeGreaterThan(slots[8].pos.x);
    expect(slots[9].pos.y).toBeLessThan(slots[11].pos.y);
  });

  test('slot 3 (east face, north end) sits at (0.883, 0.796, 0) and its first outside lattice point is (2, 1)', () => {
    const s = slotInfos(asm, def(ASSEMBLER))[3];
    expect(s.pos.x).toBeCloseTo(1.11 * M, 9);
    expect(s.pos.x).toBeCloseTo(0.883, 3);
    expect(s.pos.y).toBeCloseTo(0.796, 3);
    expect(s.pos.z).toBe(0);
    expect(s.dir).toEqual([1, 0]);
    expect(s.firstOutside).toEqual({ x: 2, y: 1 });
  });

  test('a span-2 sorter taps the belt at (3, 1), span 1 at (2, 1), span 3 at (4, 1)', () => {
    const s = slotInfos(asm, def(ASSEMBLER))[3];
    expect(sorterTapPoint(s, 1)).toEqual({ x: 2, y: 1 });
    expect(sorterTapPoint(s, 2)).toEqual({ x: 3, y: 1 });
    expect(sorterTapPoint(s, 3)).toEqual({ x: 4, y: 1 });
  });

  test('the same at yaw 90: slot 3 is on the south face, (0.796, -0.883), first outside (1, -2)', () => {
    const s = slotInfos(placed(ASSEMBLER, 0, 0, 90), def(ASSEMBLER))[3];
    expect(s.pos.x).toBeCloseTo(0.796, 3);
    expect(s.pos.y).toBeCloseTo(-0.883, 3);
    expect(s.dir).toEqual([0, -1]);
    expect(s.firstOutside).toEqual({ x: 1, y: -2 });
    expect(sorterTapPoint(s, 2)).toEqual({ x: 1, y: -3 });
  });

  test('every slot at every yaw faces away from the centre and ends on a lattice point outside the footprint', () => {
    for (const yaw of YAWS) {
      for (const s of slotInfos(placed(ASSEMBLER, 0, 0, yaw), def(ASSEMBLER))) {
        const along = s.pos.x * s.dir[0] + s.pos.y * s.dir[1];
        expect(along, `yaw ${yaw} slot ${s.index}`).toBeCloseTo(1.11 * M, 9);
        const out = (s.firstOutside.x - s.pos.x) * s.dir[0] + (s.firstOutside.y - s.pos.y) * s.dir[1];
        expect(out, `yaw ${yaw} slot ${s.index}`).toBeGreaterThan(0);
        expect(out).toBeLessThan(2);
        expect(Number.isInteger(s.firstOutside.x) && Number.isInteger(s.firstOutside.y)).toBe(true);
        // On the 4 m (3.18 tile) wide box, the first lattice point past the face is 2 tiles out.
        expect(Math.max(Math.abs(s.firstOutside.x), Math.abs(s.firstOutside.y))).toBe(2);
      }
    }
  });

  test('a smelter (3 m) has its north-east slot 2 at lateral 1 and first outside (1, 2)', () => {
    const s = slotInfos(placed(SMELTER, 0, 0), def(SMELTER))[2];
    expect(s.dir).toEqual([0, 1]);
    expect(s.pos.x).toBeCloseTo(M, 9);
    expect(s.firstOutside).toEqual({ x: 1, y: 2 });
  });

  test('a building on a half-tile position finds its lattice points on the world lattice', () => {
    const s = slotInfos(placed(ASSEMBLER, 0.5, 0.5), def(ASSEMBLER))[3];
    // Footprint x from -1.09 to 2.09: 2 is still inside, 3 is the first free lattice point.
    expect(s.firstOutside).toEqual({ x: 3, y: 1 });
  });

  test('a building without slots has none', () => {
    expect(slotInfos(placed(ILS, 0, 0), def(ILS))).toEqual([]);
  });

  test('a slot that does not face along an axis is rejected with its building and slot', () => {
    const skew: Pose = { position: [1.11, 0, 0], rotation: [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)] };
    const bd: Building = { ...def(ASSEMBLER), geometry: { ...def(ASSEMBLER).geometry, slots: [skew] } };
    expect(() => slotInfos(placed(ASSEMBLER, 0, 0, 0, 7), bd)).toThrow(/building 7.*slot 0.*axis/);
  });

  test('agrees with the hand-written slot-cell rule of the M0 script, for every slot at every yaw', () => {
    for (const itemId of [ASSEMBLER, SMELTER]) {
      for (const yaw of YAWS) {
        const b = placed(itemId, 3, -2, yaw);
        const bd = def(itemId);
        slotInfos(b, bd).forEach((s, i) => {
          const cell = slotCell(b, bd, bd.geometry.slots[i]);
          expect(s.firstOutside, `${itemId} yaw ${yaw} slot ${i}`).toEqual(cell.firstOutside);
          expect(s.dir).toEqual(cell.dir);
          expect(s.pos.x).toBeCloseTo(cell.pos.x, 12);
          expect(s.pos.y).toBeCloseTo(cell.pos.y, 12);
        });
      }
    }
  });
});

describe('portInfos', () => {
  const station = placed(ILS, 0, 0);

  test('a station has 12 ports, counter-clockwise from the north side\'s east port', () => {
    const ports = portInfos(station, def(ILS));
    expect(ports).toHaveLength(12);
    expect(ports.map((p) => p.dir.join(','))).toEqual([
      ...Array(3).fill('0,1'),
      ...Array(3).fill('-1,0'),
      ...Array(3).fill('0,-1'),
      ...Array(3).fill('1,0'),
    ]);
    expect(ports[0].pos.x).toBeGreaterThan(ports[2].pos.x);
    expect(ports[3].pos.y).toBeGreaterThan(ports[5].pos.y);
  });

  test('ports sit 2.70 m from the centre, one tile apart, and the belt starts at lattice point 4', () => {
    const ports = portInfos(station, def(ILS));
    expect(ports[0].pos.x).toBeCloseTo(1, 5); // fixture lateral is 1.256637 m, TILE to six digits
    expect(ports[0].pos.y).toBeCloseTo(2.7 * M, 9);
    expect(ports[0].firstOutside).toEqual({ x: 1, y: 4 });
    expect(ports[1].firstOutside).toEqual({ x: 0, y: 4 });
    expect(ports[3].firstOutside).toEqual({ x: -4, y: 1 });
    expect(ports[4].firstOutside).toEqual({ x: -4, y: 0 });
    expect(ports[7].firstOutside).toEqual({ x: 0, y: -4 });
    expect(ports[11].firstOutside).toEqual({ x: 4, y: 1 });
  });

  test('turning the station by 90° turns every port with it', () => {
    const ports = portInfos(placed(ILS, 0, 0, 90), def(ILS));
    expect(ports[1].dir).toEqual([1, 0]);
    expect(ports[1].firstOutside).toEqual({ x: 4, y: 0 });
    expect(ports[4].dir).toEqual([0, 1]);
    expect(ports[4].firstOutside).toEqual({ x: 0, y: 4 });
  });

  test('agrees with the hand-written slot-cell rule of the M0 script', () => {
    for (const yaw of YAWS) {
      const b = placed(ILS, 5, 7, yaw);
      portInfos(b, def(ILS)).forEach((p, i) => {
        const cell = slotCell(b, def(ILS), def(ILS).geometry.ports[i]);
        expect(p.firstOutside, `yaw ${yaw} port ${i}`).toEqual(cell.firstOutside);
        expect(p.dir).toEqual(cell.dir);
      });
    }
  });

  test('a building without ports has none', () => {
    expect(portInfos(placed(ASSEMBLER, 0, 0), def(ASSEMBLER))).toEqual([]);
  });
});

describe('real exports as an oracle for the slot and port rules', () => {
  test('ILS export: the first lattice point past every port is where the game put the chain\'s last belt', () => {
    const bp = loadBlueprintSample('ils-configured-0.9.24.txt');
    const recs = bp.body.buildings;
    const station = recs.find((r) => r.itemId === ILS)!;
    const b = placed(ILS, station.localOffset[0], station.localOffset[1], 0);
    const ports = portInfos(b, def(ILS));
    for (const first of recs.filter((r) => r.inputObjIdx === station.index)) {
      const port = ports[first.inputFromSlot];
      const last = recs[recs[first.outputObjIdx].outputObjIdx];
      expect(last.localOffset[0], `port ${first.inputFromSlot}`).toBeCloseTo(port.firstOutside.x, 1);
      expect(last.localOffset[1], `port ${first.inputFromSlot}`).toBeCloseTo(port.firstOutside.y, 1);
      expect(Math.abs(first.localOffset[0] - port.pos.x)).toBeLessThan(0.05);
      expect(Math.abs(first.localOffset[1] - port.pos.y)).toBeLessThan(0.05);
    }
  });

  test('capsule export: every belt-assembler sorter ends at the slot and at the tap point the span rule gives', () => {
    const bp = loadBlueprintSample('capsule-production-v2-reform-0.10.33.txt');
    const pairs = assemblerSorters(bp, ASSEMBLER_MK2);
    expect(pairs.length).toBeGreaterThanOrEqual(20);
    expect(new Set(pairs.map((p) => p.span))).toEqual(new Set([1, 2, 3]));
    for (const { sorter, assembler, kind, slot, span } of pairs) {
      const b = placed(ASSEMBLER_MK2, assembler.localOffset[0], assembler.localOffset[1], 0);
      expect(Math.abs(assembler.yaw % 360)).toBeLessThan(0.01);
      const info = slotInfos(b, def(ASSEMBLER_MK2))[slot];
      const tap = sorterTapPoint(info, span as 1 | 2 | 3);
      const [belt, building] =
        kind === 'input' ? [sorter.localOffset, sorter.localOffset2] : [sorter.localOffset2, sorter.localOffset];
      const label = `sorter ${sorter.index} slot ${slot} span ${span}`;
      // Building end: the slot position.
      expect(building[0], label).toBeCloseTo(info.pos.x, 1);
      expect(building[1], label).toBeCloseTo(info.pos.y, 1);
      // Belt end: on the tap lattice point along the normal, at the slot's own lateral coordinate.
      const alongX = info.dir[0] !== 0;
      expect(alongX ? belt[0] : belt[1], label).toBeCloseTo(alongX ? tap.x : tap.y, 2);
      expect(alongX ? belt[1] : belt[0], label).toBeCloseTo(alongX ? info.pos.y : info.pos.x, 1);
    }
  });
});

describe('endpointWorld', () => {
  const layout = layoutOf({
    buildings: [placed(ASSEMBLER, 0, 0)],
    belts: [beltOf(1, [[2, 0], [2, 1, 1], [2, 2]])],
  });

  test('a belt endpoint is its node', () => {
    expect(endpointWorld({ kind: 'belt', beltId: 1, node: 1 }, layout, data)).toEqual({ x: 2, y: 1, z: 1 });
  });

  test('a belt endpoint is a copy, not the node itself', () => {
    const p = endpointWorld({ kind: 'belt', beltId: 1, node: 0 }, layout, data);
    p.x = 99;
    expect(layout.belts[0].nodes[0].x).toBe(2);
  });

  test('a building endpoint is the slot position', () => {
    const p = endpointWorld({ kind: 'building', buildingId: 1, slot: 3 }, layout, data);
    expect(p.x).toBeCloseTo(1.11 * M, 9);
    expect(p.y).toBeCloseTo(M, 9);
    expect(p.z).toBe(0);
  });

  test('names what is missing', () => {
    expect(() => endpointWorld({ kind: 'belt', beltId: 4, node: 0 }, layout, data)).toThrow(/belt 4/);
    expect(() => endpointWorld({ kind: 'belt', beltId: 1, node: 9 }, layout, data)).toThrow(/belt 1 has no node 9/);
    expect(() => endpointWorld({ kind: 'building', buildingId: 6, slot: 0 }, layout, data)).toThrow(/building 6/);
    expect(() => endpointWorld({ kind: 'building', buildingId: 1, slot: 12 }, layout, data)).toThrow(/slot 12/);
  });
});

describe('sorterEnds', () => {
  const assembler = placed(ASSEMBLER, 0, 0);
  const layout = layoutOf({
    buildings: [assembler],
    belts: [beltOf(1, [[2, 0], [2, 1], [2, 2]])],
  });
  const slot3 = { kind: 'building', buildingId: 1, slot: 3 } as const;

  test('a N-S belt through (2,0),(2,1),(2,2) tapped at node 1: belt end (2, 0.796, 0), building end (0.883, 0.796, 0)', () => {
    const { pick, drop } = sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: slot3 }), layout, data);
    expect(pick.x).toBeCloseTo(2, 9);
    expect(pick.y).toBeCloseTo(0.796, 3);
    expect(pick.y).toBeCloseTo(M, 9);
    expect(pick.z).toBe(0);
    expect(drop.x).toBeCloseTo(0.883, 3);
    expect(drop.y).toBeCloseTo(0.796, 3);
    expect(drop.z).toBe(0);
  });

  test('an output sorter mirrors it: the building is the pick end', () => {
    const { pick, drop } = sorterEnds(sorterOf({ pick: slot3, drop: { kind: 'belt', beltId: 1, node: 1 } }), layout, data);
    expect(pick.x).toBeCloseTo(1.11 * M, 9);
    expect(drop.x).toBeCloseTo(2, 9);
    expect(drop.y).toBeCloseTo(M, 9);
  });

  test('the belt end keeps the tap node\'s height', () => {
    const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[2, 0, 2], [2, 1, 2], [2, 2, 2]])] });
    const { pick, drop } = sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: slot3 }), l, data);
    expect(pick.z).toBe(2);
    expect(drop.z).toBe(0);
  });

  test('building to building uses both slot positions', () => {
    const l = layoutOf({ buildings: [assembler, placed(ASSEMBLER, 4, 0, 0, 2)] });
    const { pick, drop } = sorterEnds(
      sorterOf({ pick: { kind: 'building', buildingId: 1, slot: 4 }, drop: { kind: 'building', buildingId: 2, slot: 10 } }),
      l,
      data,
    );
    expect(pick.x).toBeCloseTo(1.11 * M, 9);
    expect(pick.y).toBeCloseTo(0, 9);
    expect(drop.x).toBeCloseTo(4 - 1.11 * M, 9);
    expect(drop.y).toBeCloseTo(0, 9);
  });

  test('belt to belt (not used in v1) uses both tap nodes', () => {
    const l = layoutOf({ belts: [beltOf(1, [[0, 0], [1, 0]]), beltOf(2, [[5, 5], [6, 5]])] });
    const { pick, drop } = sorterEnds(
      sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: { kind: 'belt', beltId: 2, node: 0 } }),
      l,
      data,
    );
    expect(pick).toEqual({ x: 1, y: 0, z: 0 });
    expect(drop).toEqual({ x: 5, y: 5, z: 0 });
  });

  test('a tap node at the end of the belt takes its axis from the one neighbour', () => {
    for (const node of [0, 2]) {
      const { pick } = sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node }, drop: slot3 }), layout, data);
      expect(pick.x).toBeCloseTo(2, 9);
      expect(pick.y).toBeCloseTo(M, 9);
    }
  });

  test('a lone-node belt cannot be projected and stays at its node', () => {
    const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[2, 1]])] });
    const { pick } = sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 0 }, drop: slot3 }), l, data);
    expect(pick).toEqual({ x: 2, y: 1, z: 0 });
  });

  test('a belt running toward the slot (parallel to its facing) projects along itself', () => {
    // East-west belt on the slot's lateral row: the axis is parallel to the facing, so the projection slides the
    // belt end to the slot itself, a zero-length sorter. Kept as the straight-node behaviour (the axis alone decides).
    const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[3, 1], [2, 1], [1, 1]])] });
    const { pick } = sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: slot3 }), l, data);
    expect(pick.y).toBeCloseTo(1, 9);
    expect(pick.x).toBeCloseTo(1.11 * M, 9);
  });

  describe('a tap node on a corner projects onto the segment perpendicular to the slot facing', () => {
    test('belt arrives from the south, turns east: the vertical (arriving) segment', () => {
      const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[2, -1], [2, 0], [2, 1], [3, 1], [4, 1]])] });
      const { pick } = sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 2 }, drop: slot3 }), l, data);
      expect(pick.x).toBeCloseTo(2, 9);
      expect(pick.y).toBeCloseTo(M, 9);
      expect(pick.z).toBe(0);
    });

    test('belt arrives from the east, turns north: the vertical (leaving) segment', () => {
      const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[4, 1], [3, 1], [2, 1], [2, 2], [2, 3]])] });
      const { pick } = sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 2 }, drop: slot3 }), l, data);
      expect(pick.x).toBeCloseTo(2, 9);
      expect(pick.y).toBeCloseTo(M, 9);
    });

    test('the diagonal axis a corner would give is not used', () => {
      // Neighbours (2,0) and (3,1) span (1,1); projecting onto that diagonal would land well off the belt's cell.
      const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[2, 0], [2, 1], [3, 1]])] });
      const { pick } = sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: slot3 }), l, data);
      expect(pick.x).toBeCloseTo(2, 9);
    });

    test('the same for a slot on a north face (belt row runs east-west)', () => {
      // Slot 2 is the north face's east slot at (0.796, 0.883) facing north. Belt row y=2, corner at (1, 2).
      const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[-1, 2], [0, 2], [1, 2], [1, 3], [1, 4]])] });
      const { pick } = sorterEnds(
        sorterOf({ pick: { kind: 'belt', beltId: 1, node: 2 }, drop: { kind: 'building', buildingId: 1, slot: 2 } }),
        l,
        data,
      );
      expect(pick.y).toBeCloseTo(2, 9);
      expect(pick.x).toBeCloseTo(M, 9);
    });

    test('a corner with no segment perpendicular to the facing is a clear error', () => {
      const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[3, 2], [2, 1], [3, 1]])] });
      expect(() => sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: slot3 }), l, data)).toThrow(
        /belt 1 node 1.*corner.*perpendicular/,
      );
    });

    test('a straight node ignores the slot facing and uses the belt axis', () => {
      // Slot 2 faces north, but this belt runs north-south through the tap: projection along the belt, not across.
      const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[1, 1], [1, 2], [1, 3]])] });
      const { pick } = sorterEnds(
        sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: { kind: 'building', buildingId: 1, slot: 2 } }),
        l,
        data,
      );
      expect(pick.x).toBeCloseTo(1, 9);
      expect(pick.y).toBeCloseTo(1.11 * M, 9);
    });

    test('a node next to a vertical lift counts as straight on its one horizontal side', () => {
      const l = layoutOf({ buildings: [assembler], belts: [beltOf(1, [[2, 0, 0], [2, 1, 0], [2, 1, 1]])] });
      const { pick } = sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: slot3 }), l, data);
      expect(pick.x).toBeCloseTo(2, 9);
      expect(pick.y).toBeCloseTo(M, 9);
    });
  });

  test('rejects unknown buildings, belts, nodes and slots', () => {
    expect(() => sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 9, node: 0 }, drop: slot3 }), layout, data)).toThrow(/belt 9/);
    expect(() => sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 7 }, drop: slot3 }), layout, data)).toThrow(/node 7/);
    expect(() => sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: { ...slot3, buildingId: 8 } }), layout, data)).toThrow(/building 8/);
    expect(() => sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: { ...slot3, slot: 12 } }), layout, data)).toThrow(/slot 12/);
  });

  test('rejects a layout that gives two buildings or belts the same id', () => {
    const s = sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: slot3 });
    expect(() => sorterEnds(s, layoutOf({ buildings: [assembler, assembler] }), data)).toThrow(/duplicate building id 1/);
    expect(() => sorterEnds(s, layoutOf({ belts: [beltOf(1, [[0, 0]]), beltOf(1, [[1, 1]])] }), data)).toThrow(/duplicate belt id 1/);
  });
});

describe('layout index', () => {
  const slot3 = { kind: 'building', buildingId: 1, slot: 3 } as const;
  const tap = sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: slot3 });

  /** Counts every whole-array walk (iteration, map, forEach, ...) of the arrays it wraps. */
  function counting<T>(arr: T[]): { arr: T[]; walks: () => number } {
    let walks = 0;
    const walkers = new Set<PropertyKey>([Symbol.iterator, 'map', 'forEach', 'reduce', 'filter', 'entries', 'values', 'keys']);
    const proxy = new Proxy(arr, {
      get(target, key, receiver) {
        if (walkers.has(key)) walks++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return { arr: proxy, walks: () => walks };
  }

  test('sorterEnds does not rebuild the id maps on every call', () => {
    const buildings = counting([placed(ASSEMBLER, 0, 0)]);
    const belts = counting([beltOf(1, [[2, 0], [2, 1], [2, 2]])]);
    const layout = layoutOf({ buildings: buildings.arr, belts: belts.arr });
    for (let i = 0; i < 50; i++) sorterEnds(tap, layout, data);
    expect(buildings.walks() + belts.walks()).toBeLessThanOrEqual(2);
  });

  test('an index built once serves any number of calls without walking the layout again', () => {
    const buildings = counting([placed(ASSEMBLER, 0, 0)]);
    const belts = counting([beltOf(1, [[2, 0], [2, 1], [2, 2]])]);
    const layout = layoutOf({ buildings: buildings.arr, belts: belts.arr });
    const index = new LayoutIndex(layout);
    const after = buildings.walks() + belts.walks();
    expect(after).toBe(2);
    for (let i = 0; i < 50; i++) sorterEnds(tap, layout, data, index);
    expect(buildings.walks() + belts.walks()).toBe(after);
  });

  test('layoutIndex is memoised per layout object, and a different layout gets its own', () => {
    const a = layoutOf({ buildings: [placed(ASSEMBLER, 0, 0)] });
    const b = layoutOf({ buildings: [placed(ASSEMBLER, 0, 0)] });
    expect(layoutIndex(a)).toBe(layoutIndex(a));
    expect(layoutIndex(a)).not.toBe(layoutIndex(b));
  });

  test('the memo follows a layout the solver edits: added, replaced and removed buildings and belts', () => {
    const layout = layoutOf({ buildings: [placed(ASSEMBLER, 0, 0)], belts: [beltOf(1, [[2, 0], [2, 1], [2, 2]])] });
    const endsX = () => sorterEnds(tap, layout, data).drop.x;
    expect(endsX()).toBeCloseTo(1.11 * M, 9);

    // Moved in place: positions are read live.
    layout.buildings[0].x = 10;
    expect(endsX()).toBeCloseTo(10 + 1.11 * M, 9);

    // Replaced by another object with the same id.
    layout.buildings[0] = placed(ASSEMBLER, 20, 0);
    expect(endsX()).toBeCloseTo(20 + 1.11 * M, 9);

    // A building added in front shifts positions in the array.
    layout.buildings.unshift(placed(SMELTER, 50, 50, 0, 2));
    expect(endsX()).toBeCloseTo(20 + 1.11 * M, 9);
    const toSmelter = sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: { kind: 'building', buildingId: 2, slot: 3 } });
    expect(sorterEnds(toSmelter, layout, data).drop.x).toBeCloseTo(50 + 1.11 * M, 9);

    // A belt added after the index was built, and a building removed.
    layout.belts.push(beltOf(3, [[0, 0], [0, 1]]));
    expect(sorterEnds(sorterOf({ pick: { kind: 'belt', beltId: 3, node: 1 }, drop: slot3 }), layout, data).pick.x).toBeCloseTo(0, 9);
    layout.buildings.shift();
    expect(() => sorterEnds(toSmelter, layout, data)).toThrow(/building 2/);
  });

  test('an index lookup names the missing id with the caller\'s context', () => {
    const index = new LayoutIndex(layoutOf({ buildings: [placed(ASSEMBLER, 0, 0)] }));
    expect(index.building(1, 'thing').id).toBe(1);
    expect(() => index.building(5, 'belt 2 source')).toThrow('belt 2 source: building 5 is not in the layout');
    expect(() => index.belt(5, 'belt 2 sink')).toThrow('belt 2 sink: belt 5 is not in the layout');
  });
});
