import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildM0Blueprint, buildM0Layout, insideFootprint, slotCell, writeM0Blueprint } from '../../../scripts/emit-test-blueprint';
import { assemblerSorters, loadBlueprintSample } from '../../../test/fixtures/blueprintSamples';
import { GameDataIndex, parseGameData } from '../data';
import { headingDeg, portInfos, prefabToGrid, slotInfos, sorterEnds, sorterTapPoint, TILE } from '../geometry';
import type { BeltPath, Layout, PlacedBuilding, Sorter, StationConfig, StationPortConfig } from '../geometry';
import { layoutToBlueprint, layoutToBlueprintString } from './build';
import { decodeBlueprint, encodeBlueprint } from './codec';
import type { BlueprintBuilding } from './model';

const fixturePath = fileURLToPath(new URL('../../../../data/fixture/dsp-fixture.json', import.meta.url));
const data = new GameDataIndex(parseGameData(JSON.parse(readFileSync(fixturePath, 'utf8')), 'dsp-fixture.json'));

/** 2026-01-02 03:04:05 local wall-clock time. */
const NOW = new Date(2026, 0, 2, 3, 4, 5);
const OPTS = { shortDesc: 'test', desc: 'hand-made', now: NOW };

const meta = (geometrySource: 'approximate' | 'extracted' = 'approximate') => ({
  geometrySource,
  gameVersion: '0.10.29.22015',
  planTargetItemId: 1101,
  planTargetRate: 1,
});

const ports12 = (over: Record<number, StationPortConfig> = {}): StationPortConfig[] =>
  Array.from({ length: 12 }, (_, i) => over[i] ?? { dir: 0, storageIdx: 0 });

const station = (over: Partial<StationConfig> = {}): StationConfig => ({
  slots: [],
  ports: ports12(),
  chargePerTick: 1000000,
  pilerCount: 1,
  ...over,
});

const ils = (over: Partial<PlacedBuilding> = {}): PlacedBuilding => ({
  id: 1,
  itemId: 2104,
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  station: station(),
  ...over,
});

const smelter = (over: Partial<PlacedBuilding> = {}): PlacedBuilding => ({
  id: 2,
  itemId: 2302,
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  recipeId: 1,
  ...over,
});

const tower = (id: number, x: number, y: number): PlacedBuilding => ({ id, itemId: 2201, x, y, z: 0, yaw: 0 });

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
  meta: meta(),
  ...over,
});

const records = (layout: Layout, opts = OPTS) => decodeBlueprint(layoutToBlueprintString(layout, data, opts)).body.buildings;
const xy = (r: BlueprintBuilding) => [r.localOffset[0], r.localOffset[1]];

/**
 * An ILS with a smelter row: ore leaves port 3 on belt 1, the smelter's north slot 2 gets a sorter from
 * belt 1, its south slot 8 a sorter onto belt 2, and belt 2 returns to port 4.
 */
function richLayout(): Layout {
  const oreNodes: [number, number][] = [-4, -5, -6, -7, -8, -9].map((x) => [x, 1]);
  const returnNodes: [number, number][] = [
    [-9, -3],
    [-8, -3],
    [-7, -3],
    [-6, -3],
    [-5, -3],
    [-5, -2],
    [-5, -1],
    [-5, 0],
    [-4, 0],
  ];
  return layoutOf({
    buildings: [
      ils({
        station: station({
          slots: [
            { itemId: 1001, localLogic: 2, remoteLogic: 2, max: 10000 },
            { itemId: 1101, localLogic: 1, remoteLogic: 1, max: 10000 },
          ],
          ports: ports12({ 3: { dir: 1, storageIdx: 1 }, 4: { dir: 2, storageIdx: 0 } }),
        }),
      }),
      smelter({ x: -8, y: -1 }),
      tower(3, -3, 3),
    ],
    belts: [
      beltOf(1, oreNodes, { source: { buildingId: 1, port: 3 } }),
      beltOf(2, returnNodes, { itemId: 1101, sink: { kind: 'port', buildingId: 1, port: 4 } }),
    ],
    sorters: [
      sorterOf({ id: 1, pick: { kind: 'belt', beltId: 1, node: 3 }, drop: { kind: 'building', buildingId: 2, slot: 2 } }),
      sorterOf({
        id: 2,
        filterItemId: 1101,
        pick: { kind: 'building', buildingId: 2, slot: 8 },
        drop: { kind: 'belt', beltId: 2, node: 0 },
      }),
    ],
  });
}

describe('layoutToBlueprint', () => {
  test('(a) station with a Mk.III belt leaving port 3: round-trips, links and port params', () => {
    const l = layoutOf({
      buildings: [ils({ station: station({ ports: ports12({ 3: { dir: 1, storageIdx: 1 } }) }) })],
      belts: [
        beltOf(
          1,
          [[-4, 1], [-5, 1], [-6, 1], [-7, 1], [-8, 1]],
          { tierItemId: 2003, source: { buildingId: 1, port: 3 } },
        ),
      ],
    });
    const str = layoutToBlueprintString(l, data, OPTS);
    const bp = decodeBlueprint(str);
    expect(encodeBlueprint(bp)).toBe(str);

    const recs = bp.body.buildings;
    // Station, then the two port stubs, then the five nodes.
    expect(recs).toHaveLength(8);
    expect(recs[0].itemId).toBe(2104);
    expect(recs[0].parameters).toHaveLength(2048);
    expect(recs[0].parameters[192 + 4 * 3]).toBe(1);
    expect(recs[0].parameters[192 + 4 * 3 + 1]).toBe(1);
    for (let i = 1; i <= 7; i++) {
      expect(recs[i].itemId).toBe(2003);
      expect(recs[i].modelIndex).toBe(data.building(2003)?.modelIndex);
    }
    for (let i = 1; i <= 6; i++) expect(recs[i].outputObjIdx).toBe(i + 1);
    expect(recs[7].outputObjIdx).toBe(-1);
    expect(recs[1].inputObjIdx).toBe(0);
    expect(recs[1].inputFromSlot).toBe(3);
    for (let i = 2; i <= 7; i++) expect(recs[i].inputObjIdx).toBe(-1);
    // Belt chain slot pattern (BF §3.3) while a belt feeds another record; the open end has no target slot.
    for (let i = 2; i <= 6; i++) {
      expect([recs[i].outputToSlot, recs[i].inputFromSlot, recs[i].outputFromSlot, recs[i].inputToSlot]).toEqual([1, 0, 0, 1]);
    }
    expect([recs[1].outputToSlot, recs[1].outputFromSlot, recs[1].inputToSlot]).toEqual([1, 0, 1]);
    expect([recs[7].outputToSlot, recs[7].inputFromSlot, recs[7].outputFromSlot, recs[7].inputToSlot]).toEqual([0, 0, 0, 1]);
    for (const r of recs.slice(1)) expect([r.outputOffset, r.inputOffset, r.tilt, r.tilt2, r.pitch]).toEqual([0, 0, 0, 0, 0]);
  });

  test('(b) smelter, Mk.I sorter and belt: the sorter links to the smelter and the belt tap node', () => {
    const l = layoutOf({
      buildings: [smelter({ id: 1 })],
      belts: [beltOf(1, [[-1, 2], [0, 2], [1, 2]])],
      sorters: [
        sorterOf({
          span: 1,
          filterItemId: 1001,
          pick: { kind: 'belt', beltId: 1, node: 1 },
          drop: { kind: 'building', buildingId: 1, slot: 1 },
        }),
      ],
    });
    const recs = records(l);
    // Order: smelter, belt nodes 0..2, sorter.
    expect(recs.map((r) => r.itemId)).toEqual([2302, 2001, 2001, 2001, 2011]);
    expect(recs[0].recipeId).toBe(1);
    expect(Array.from(recs[0].parameters)).toEqual([0]);
    expect([recs[0].outputToSlot, recs[0].inputFromSlot, recs[0].outputFromSlot, recs[0].inputToSlot]).toEqual([0, 0, 0, 0]);

    const s = recs[4];
    expect(s.marker).toBe(-101);
    expect(s.inputObjIdx).toBe(2); // belt node 1
    expect(s.outputObjIdx).toBe(0); // smelter
    expect(s.inputFromSlot).toBe(-1);
    expect(s.outputToSlot).toBe(1);
    expect([s.outputFromSlot, s.inputToSlot, s.outputOffset, s.inputOffset]).toEqual([0, 1, 0, 0]);
    expect(s.parameters[0]).toBe(1);
    expect(s.parameters).toHaveLength(1);
    expect(s.filterId).toBe(1001);
    expect(s.modelIndex).toBe(data.building(2011)?.modelIndex);
    // Pick on the belt line above the slot, drop at the slot: pointing south.
    expect(s.yaw).toBeCloseTo(180, 4);
    expect(s.yaw2).toBeCloseTo(180, 4);
    expect([s.tilt, s.pitch, s.tilt2, s.pitch2]).toEqual([0, 0, 0, 0]);
    expect(s.localOffset[0]).toBeCloseTo(1, 5); // x = 0 shifted by +1
    expect(s.localOffset[1]).toBeCloseTo(2, 5);
    expect(s.localOffset2[0]).toBeCloseTo(1, 5);
    expect(s.localOffset2[1]).toBeCloseTo(1.11 / TILE, 5);
  });

  test('(b2) a sorter from a smelter slot onto a belt records the pick slot and no drop slot', () => {
    const l = layoutOf({
      buildings: [smelter({ id: 1 })],
      belts: [beltOf(1, [[-1, -2], [0, -2], [1, -2]], { itemId: 1101 })],
      sorters: [
        sorterOf({
          tierItemId: 2013,
          span: 2,
          filterItemId: 1101,
          pick: { kind: 'building', buildingId: 1, slot: 7 },
          drop: { kind: 'belt', beltId: 1, node: 1 },
        }),
      ],
    });
    const s = records(l)[4];
    expect(s.itemId).toBe(2013);
    expect(s.inputObjIdx).toBe(0);
    expect(s.outputObjIdx).toBe(2);
    expect(s.inputFromSlot).toBe(7);
    expect(s.outputToSlot).toBe(-1);
    expect(s.parameters[0]).toBe(2);
    expect(s.yaw).toBeCloseTo(180, 4);
  });

  test('(c) desc carries the approximate-geometry flag only when the geometry is approximate', () => {
    const approx = decodeBlueprint(layoutToBlueprintString(layoutOf({ buildings: [tower(1, 0, 0)] }), data, OPTS));
    expect(approx.header.desc).toContain('approximate');
    expect(approx.header.desc).toBe('hand-made\n[geometry: approximate - unverified in game]');

    const extracted = decodeBlueprint(
      layoutToBlueprintString(layoutOf({ buildings: [tower(1, 0, 0)], meta: meta('extracted') }), data, OPTS),
    );
    expect(extracted.header.desc).not.toContain('approximate');
    expect(extracted.header.desc).toBe('hand-made');

    const noDesc = decodeBlueprint(
      layoutToBlueprintString(layoutOf({ buildings: [tower(1, 0, 0)] }), data, { ...OPTS, desc: '' }),
    );
    expect(noDesc.header.desc).toBe('[geometry: approximate - unverified in game]');
  });

  test('(d) every record has index == position and every link is in range', () => {
    const recs = records(richLayout());
    // 3 buildings + (2 + 6) ore + (9 + 2) return + 2 sorters.
    expect(recs).toHaveLength(3 + 8 + 11 + 2);
    recs.forEach((r, i) => {
      expect(r.index).toBe(i);
      expect(r.marker).toBe(-101);
      expect(r.areaIndex).toBe(0);
      for (const link of [r.outputObjIdx, r.inputObjIdx]) {
        expect(link).toBeGreaterThanOrEqual(-1);
        expect(link).toBeLessThan(recs.length);
      }
    });
  });

  test('(e) station slot params: item, local logic, remote logic, max per storage', () => {
    const l = layoutOf({
      buildings: [
        ils({
          station: station({
            slots: [
              { itemId: 1001, localLogic: 2, remoteLogic: 2, max: 10000 },
              { itemId: 1101, localLogic: 1, remoteLogic: 1, max: 10000 },
            ],
            chargePerTick: 1000000,
            pilerCount: 3,
          }),
        }),
      ],
    });
    const p = records(l)[0].parameters;
    expect(Array.from(p.slice(0, 4))).toEqual([1001, 2, 2, 10000]);
    expect(Array.from(p.slice(6, 10))).toEqual([1101, 1, 1, 10000]);
    expect(Array.from(p.slice(4, 6))).toEqual([0, 0]); // keepMode, unused
    expect(Array.from(p.slice(12, 192)).every((v) => v === 0)).toBe(true);
    expect(p[320]).toBe(1000000);
    expect(p[321]).toBe(64278761);
    expect(p[326]).toBe(1);
    expect(p[327]).toBe(1);
    expect(p[328]).toBe(3);
    expect(p[330]).toBe(1);
    for (const i of [322, 323, 324, 325, 329, 331]) expect(p[i], `params[${i}]`).toBe(0);
    expect(Array.from(p.slice(332)).every((v) => v === 0)).toBe(true);
  });

  test('(e2) port params: dir at 192 + 4s, 1-based storage index at 192 + 4s + 1', () => {
    const l = layoutOf({
      buildings: [
        ils({
          station: station({
            slots: [
              { itemId: 1001, localLogic: 2, remoteLogic: 2, max: 10 },
              { itemId: 1101, localLogic: 1, remoteLogic: 1, max: 10 },
            ],
            ports: ports12({ 3: { dir: 1, storageIdx: 1 }, 4: { dir: 2, storageIdx: 0 }, 11: { dir: 1, storageIdx: 2 } }),
          }),
        }),
      ],
    });
    const p = records(l)[0].parameters;
    const expected = Array<number>(48).fill(0);
    [expected[12], expected[13]] = [1, 1]; // port 3: output of storage 1
    expected[16] = 2; // port 4: input
    [expected[44], expected[45]] = [1, 2]; // port 11: output of storage 2
    expect(Array.from(p.slice(192, 192 + 48))).toEqual(expected);
  });

  test('(f) port stubs: two records before the first node, the first at the port position, linked to the node', () => {
    const l = layoutOf({
      buildings: [ils({ station: station({ ports: ports12({ 0: { dir: 1, storageIdx: 1 } }) }) })],
      belts: [beltOf(1, [[1, 4], [1, 5], [1, 6]], { source: { buildingId: 1, port: 0 } })],
    });
    const recs = records(l);
    expect(recs).toHaveLength(1 + 2 + 3);
    const port0 = data.building(2104)!.geometry.ports[0].position;
    const expected = prefabToGrid({ x: 0, y: 0, z: 0, yaw: 0 }, port0);
    // The ILS sits at the minimum corner, so nothing is shifted.
    expect(recs[1].localOffset[0]).toBeCloseTo(expected.x, 2);
    expect(recs[1].localOffset[1]).toBeCloseTo(expected.y, 2);
    expect(recs[1].localOffset[1]).toBeCloseTo(2.7 / TILE, 2);
    // Midpoint between the port position and node 0.
    expect(recs[2].localOffset[0]).toBeCloseTo(1, 4);
    expect(recs[2].localOffset[1]).toBeCloseTo((2.7 / TILE + 4) / 2, 4);
    expect(xy(recs[3])).toEqual([1, 4]);
    expect(recs[1].inputObjIdx).toBe(0);
    expect(recs[1].inputFromSlot).toBe(0);
    expect(recs[2].inputObjIdx).toBe(-1);
    expect(recs[3].inputObjIdx).toBe(-1);
    expect([recs[1].outputObjIdx, recs[2].outputObjIdx, recs[3].outputObjIdx, recs[4].outputObjIdx, recs[5].outputObjIdx]).toEqual([2, 3, 4, 5, -1]);
    // The belt flows north all the way.
    for (const r of recs.slice(1)) expect(r.yaw).toBeCloseTo(0, 4);
  });

  test('(f2) a port sink mirrors the stubs after the last node and links the station', () => {
    const recs = records(richLayout());
    // Ore belt: 2 source stubs + 6 nodes at 3..10; return belt: 9 nodes at 11..19 + 2 sink stubs at 20, 21.
    const ret = recs.slice(11, 22);
    expect(ret.map((r) => r.outputObjIdx)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 0]);
    expect(ret[10].outputToSlot).toBe(4);
    expect(ret[9].outputToSlot).toBe(1);
    expect(ret[8].outputToSlot).toBe(1);
    for (const r of ret) expect(r.inputObjIdx).toBe(-1);
    // Last node (-4,0), then the midpoint, then the port 4 position 2.7 m from the centre.
    const [last, mid, port] = [recs[19], recs[20], recs[21]];
    const dx = (r: BlueprintBuilding) => r.localOffset[0] - recs[0].localOffset[0];
    expect(dx(last)).toBeCloseTo(-4, 4);
    expect(dx(mid)).toBeCloseTo((-4 - 2.7 / TILE) / 2, 4);
    expect(dx(port)).toBeCloseTo(-2.7 / TILE, 4);
    expect(port.localOffset[1]).toBeCloseTo(last.localOffset[1], 4);
    // Heading east into the station.
    for (const r of [last, mid, port]) expect(r.yaw).toBeCloseTo(90, 4);
    // The ore belt's source link.
    expect(recs[3].inputObjIdx).toBe(0);
    expect(recs[3].inputFromSlot).toBe(3);
  });

  test('(f3) a belt sink links the merge node of the target belt', () => {
    const l = layoutOf({
      belts: [
        beltOf(1, [[0, 0], [1, 0]], { sink: { kind: 'belt', beltId: 2, node: 1 } }),
        beltOf(2, [[2, -1], [2, 0], [2, 1]]),
      ],
    });
    const recs = records(l);
    expect(recs).toHaveLength(5);
    expect(recs[1].outputObjIdx).toBe(3); // belt 2, node 1
    expect(recs[1].outputToSlot).toBe(1);
    expect(recs[1].yaw).toBeCloseTo(90, 4); // the last node keeps the direction of the one before
    expect(recs[4].outputObjIdx).toBe(-1);
  });

  test('(g) the translation is an integer: a layout with minimum x -3.6 shifts every record by +4', () => {
    const recs = records(layoutOf({ buildings: [tower(1, -3.6, 1), tower(2, 5, 7.5)] }));
    expect(recs[0].localOffset[0]).toBeCloseTo(0.4, 5);
    expect(recs[0].localOffset[1]).toBe(0);
    expect(recs[1].localOffset[0]).toBe(9);
    expect(recs[1].localOffset[1]).toBe(6.5);
  });

  test('(g2) fractional sorter ends take part in the minimum', () => {
    const l = layoutOf({
      buildings: [smelter({ id: 1 })],
      belts: [beltOf(1, [[0, 2], [1, 2], [2, 2]])],
      sorters: [
        sorterOf({ pick: { kind: 'belt', beltId: 1, node: 0 }, drop: { kind: 'building', buildingId: 1, slot: 0 } }),
      ],
    });
    const recs = records(l);
    // Slot 0 sits 1/TILE west of the centre, so the sorter reaches x = -0.796 and everything shifts by +1.
    expect(recs[0].localOffset[0]).toBe(1);
    expect(recs[1].localOffset[0]).toBe(1);
    expect(recs[3].localOffset[0]).toBe(3);
    expect(recs[4].localOffset[0]).toBeCloseTo(1 - 1 / TILE, 5);
    expect(recs[4].localOffset2[0]).toBeCloseTo(1 - 1 / TILE, 5);
    // y is untouched: the smelter at 0 is the minimum.
    expect(recs[0].localOffset[1]).toBe(0);
    expect(recs[1].localOffset[1]).toBe(2);
  });

  test('(h) a belt-to-assembler-side-slot sorter ends on the belt at the slot lateral coordinate', () => {
    const l = layoutOf({
      buildings: [{ id: 1, itemId: 2303, x: 0, y: 0, z: 0, yaw: 0 }],
      belts: [beltOf(1, [[2, 0], [2, 1], [2, 2]])],
      sorters: [
        sorterOf({ pick: { kind: 'belt', beltId: 1, node: 1 }, drop: { kind: 'building', buildingId: 1, slot: 3 } }),
      ],
    });
    const recs = records(l);
    const s = recs[4];
    expect(s.localOffset[0]).toBeCloseTo(2, 5);
    expect(s.localOffset[1]).toBeCloseTo(1 / TILE, 5); // 0.796, not the node's 1
    expect(s.localOffset2[0]).toBeCloseTo(1.11 / TILE, 5);
    expect(s.localOffset2[1]).toBeCloseTo(1 / TILE, 5);
    expect(s.yaw).toBeCloseTo(270, 3); // belt (east) to assembler (west of it)
    expect(s.inputObjIdx).toBe(2);
    expect(s.outputObjIdx).toBe(0);
    expect(s.outputToSlot).toBe(3);
  });

  test('a vertical lift keeps its heading, z is in levels, and tilt stays 0', () => {
    const l = layoutOf({
      belts: [beltOf(1, [[0, 0, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1], [2, 1, 1]])],
    });
    const recs = records(l);
    expect(recs.map((r) => r.localOffset[2])).toEqual([0, 0, 1, 1, 1]);
    expect(recs[0].yaw).toBeCloseTo(0, 4);
    expect(recs[1].yaw).toBeCloseTo(0, 4); // the lift node keeps the heading it arrived with
    expect(recs[2].yaw).toBeCloseTo(90, 4);
    expect(recs[3].yaw).toBeCloseTo(90, 4);
    expect(recs[4].yaw).toBeCloseTo(90, 4);
    for (const r of recs) expect([r.tilt, r.tilt2, r.pitch, r.pitch2]).toEqual([0, 0, 0, 0]);
  });

  test('a belt that starts with a lift takes the first real heading', () => {
    const recs = records(layoutOf({ belts: [beltOf(1, [[0, 0, 0], [0, 0, 1], [1, 0, 1]])] }));
    expect(recs.map((r) => r.yaw)).toEqual([90, 90, 90]);
  });

  test('a corner node takes the bisector of the incoming and outgoing headings, straight nodes keep theirs', () => {
    const recs = records(layoutOf({ belts: [beltOf(1, [[0, 0], [1, 0], [1, -1], [2, -1]])] }));
    // East, a south turn, an east turn: 90, 135 (bisector of 90 and 180), 135 (of 180 and 90), 90.
    expect(recs.map((r) => r.yaw)).toEqual([90, 135, 135, 90]);
    expect(recs.map((r) => r.yaw2)).toEqual([90, 135, 135, 90]);
    // The turn across north: 0 in, 270 out, bisector 315.
    expect(records(layoutOf({ belts: [beltOf(1, [[0, 0], [0, 1], [-1, 1]])] })).map((r) => r.yaw)).toEqual([0, 315, 270]);
  });

  test('a belt that leaves a port and turns at its first node takes the bisector there too', () => {
    const l = layoutOf({
      buildings: [ils({ station: station({ ports: ports12({ 1: { dir: 1, storageIdx: 1 } }) }) })],
      belts: [beltOf(1, [[0, 4], [1, 4], [2, 4]], { source: { buildingId: 1, port: 1 } })],
    });
    // Two stubs heading north, then the corner at (0, 4): 0 in, 90 out.
    expect(records(l).slice(1).map((r) => r.yaw)).toEqual([0, 0, 45, 90, 90]);
  });

  test('building yaw is written in degrees clockwise from north', () => {
    const recs = records(layoutOf({ buildings: [smelter({ yaw: 270 })] }));
    expect(recs[0].yaw).toBe(270);
    expect(recs[0].yaw2).toBe(270);
  });

  test('header and body follow the output profile', () => {
    const bp = decodeBlueprint(layoutToBlueprintString(richLayout(), data, OPTS));
    expect(bp.header.headerVersion).toBe(0);
    expect(bp.header.layout).toBe(10);
    expect(bp.header.icons).toEqual([1101, 0, 0, 0, 0]);
    expect(bp.header.gameVersion).toBe('0.10.29.22015');
    expect(bp.header.shortDesc).toBe('test');
    // 2026-01-02 03:04:05 local wall-clock, in .NET ticks.
    expect(bp.header.ticks).toBe(BigInt(Date.UTC(2026, 0, 2, 3, 4, 5)) * 10000n + 621355968000000000n);
    expect(bp.gzipOs).toBe(0x0a);

    const b = bp.body;
    expect(b.version).toBe(2);
    expect(b.patch2).toBe(1);
    expect(Array.from(b.reformRaw ?? [])).toEqual([0]);
    expect(b.primaryAreaIdx).toBe(0);
    expect(b.cursorTargetArea).toBe(0);
    expect(b.areas).toHaveLength(1);

    const all = b.buildings.flatMap((r) => [xy(r), [r.localOffset2[0], r.localOffset2[1]]]);
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...xs)).toBeLessThan(1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ys)).toBeLessThan(1);
    const w = Math.ceil(Math.max(...xs) - Math.min(...xs)) + 1;
    const h = Math.ceil(Math.max(...ys) - Math.min(...ys)) + 1;
    expect(b.areas[0]).toEqual({
      index: 0,
      parentIndex: -1,
      tropicAnchor: 0,
      areaSegments: 200,
      anchorLocalOffsetX: 0,
      anchorLocalOffsetY: 0,
      width: w,
      height: h,
    });
    expect([b.cursorOffsetX, b.cursorOffsetY]).toEqual([Math.floor(w / 2), Math.floor(h / 2)]);
    expect([b.dragBoxSizeX, b.dragBoxSizeY]).toEqual([w, h]);
    expect(Math.max(...xs)).toBeLessThan(w);
    expect(Math.max(...ys)).toBeLessThan(h);
  });

  test('an empty layout still produces a valid one-cell blueprint', () => {
    const bp = decodeBlueprint(layoutToBlueprintString(layoutOf({}), data, OPTS));
    expect(bp.body.buildings).toHaveLength(0);
    expect([bp.body.areas[0].width, bp.body.areas[0].height]).toEqual([1, 1]);
  });

  test('layoutToBlueprint returns the Blueprint that the string encodes', () => {
    const l = richLayout();
    const bp = layoutToBlueprint(l, data, OPTS);
    expect(encodeBlueprint(bp)).toBe(layoutToBlueprintString(l, data, OPTS));
    expect(bp.header.rawCells).toEqual([]);
  });

  test('the default timestamp is the current time', () => {
    const before = Date.now();
    const { header } = layoutToBlueprint(layoutOf({}), data, { shortDesc: 's', desc: 'd' });
    const ms = Number((header.ticks - 621355968000000000n) / 10000n) + new Date().getTimezoneOffset() * 60000;
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(Date.now() + 1000);
  });

  describe('rejects layouts it cannot express', () => {
    const build = (l: Layout) => () => layoutToBlueprint(l, data, OPTS);

    test('an item that is not a building', () => {
      expect(build(layoutOf({ buildings: [tower(1, 0, 0), { ...tower(2, 1, 1), itemId: 1001 }] }))).toThrow(/item 1001/);
    });

    test('a belt source or sink on a missing building or port', () => {
      const nodes: [number, number][] = [[-4, 1], [-5, 1]];
      expect(build(layoutOf({ belts: [beltOf(1, nodes, { source: { buildingId: 9, port: 0 } })] }))).toThrow(/building 9/);
      expect(build(layoutOf({ buildings: [ils()], belts: [beltOf(1, nodes, { source: { buildingId: 1, port: 12 } })] }))).toThrow(/port 12/);
      expect(build(layoutOf({ buildings: [ils()], belts: [beltOf(1, nodes, { sink: { kind: 'port', buildingId: 1, port: 99 } })] }))).toThrow(/port 99/);
      expect(build(layoutOf({ belts: [beltOf(1, nodes, { sink: { kind: 'belt', beltId: 5, node: 0 } })] }))).toThrow(/belt 5/);
      expect(build(layoutOf({ belts: [beltOf(1, nodes), beltOf(2, nodes, { sink: { kind: 'belt', beltId: 1, node: 2 } })] }))).toThrow(/node 2/);
    });

    test('a belt without nodes, and duplicate ids', () => {
      expect(build(layoutOf({ belts: [beltOf(1, [])] }))).toThrow(/belt 1 has no nodes/);
      expect(build(layoutOf({ buildings: [tower(1, 0, 0), tower(1, 2, 2)] }))).toThrow(/duplicate building id 1/);
      expect(build(layoutOf({ belts: [beltOf(1, [[0, 0]]), beltOf(1, [[1, 1]])] }))).toThrow(/duplicate belt id 1/);
    });

    test('a sorter endpoint that is not in the layout', () => {
      const l = layoutOf({
        buildings: [smelter({ id: 1 })],
        sorters: [sorterOf({ pick: { kind: 'belt', beltId: 4, node: 0 }, drop: { kind: 'building', buildingId: 1, slot: 1 } })],
      });
      expect(build(l)).toThrow(/belt 4/);
    });

    test('station configuration that does not fit the building', () => {
      const slot = { itemId: 1001, localLogic: 2, remoteLogic: 2, max: 1 } as const;
      expect(build(layoutOf({ buildings: [ils({ station: station({ slots: Array(6).fill(slot) }) })] }))).toThrow(/at most 5/);
      // The Planetary Logistics Station has four storages.
      expect(build(layoutOf({ buildings: [ils({ itemId: 2103, station: station({ slots: Array(5).fill(slot) }) })] }))).toThrow(/at most 4/);
      expect(build(layoutOf({ buildings: [ils({ station: station({ ports: ports12().slice(0, 11) }) })] }))).toThrow(/12 ports/);
      expect(build(layoutOf({ buildings: [{ ...smelter(), station: station() }] }))).toThrow(/not a station/);
    });
  });
});

/** Angle between two headings in degrees, in [0, 180]. */
const headingGap = (a: number, b: number): number => Math.abs((((a - b) % 360) + 540) % 360 - 180);

describe('real exports as an oracle for what the builder must reproduce', () => {
  const ILS_ID = 2104;
  const near = (a: number, b: number, tol: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThan(tol);
  const links = (r: BlueprintBuilding) => [r.outputToSlot, r.inputFromSlot, r.outputFromSlot, r.inputToSlot];

  test('ILS export: a belt leaving each port has the same links, slot fields and stub spacing as the game writes', () => {
    const sample = loadBlueprintSample('ils-configured-0.9.24.txt').body.buildings;
    const sampleStation = sample.find((r) => r.itemId === ILS_ID)!;
    const sampleChains = sample.filter((r) => r.inputObjIdx === sampleStation.index).sort((a, b) => a.inputFromSlot - b.inputFromSlot);
    expect(sampleChains).toHaveLength(12);

    // The same station with all 12 ports as outputs, each with a one-node Mk.II belt on the first lattice point out.
    const station12 = ils({
      x: sampleStation.localOffset[0],
      y: sampleStation.localOffset[1],
      station: station({ ports: ports12(Object.fromEntries(Array.from({ length: 12 }, (_, p) => [p, { dir: 1 as const, storageIdx: 1 }]))) }),
    });
    const ports = portInfos(station12, data.building(ILS_ID)!);
    const layout = layoutOf({
      buildings: [station12],
      belts: ports.map((p, i) =>
        beltOf(i + 1, [[p.firstOutside.x, p.firstOutside.y]], { tierItemId: 2002, source: { buildingId: 1, port: p.index } }),
      ),
    });
    const ours = records(layout);
    expect(ours).toHaveLength(1 + 12 * 3);

    sampleChains.forEach((first, port) => {
      const theirs = [first, sample[first.outputObjIdx], sample[sample[first.outputObjIdx].outputObjIdx]];
      const mine = ours.slice(1 + 3 * port, 4 + 3 * port);
      const label = `port ${port}`;
      expect(first.inputFromSlot, label).toBe(port);
      mine.forEach((m, i) => {
        const t = theirs[i];
        expect(m.itemId, label).toBe(t.itemId);
        expect(m.modelIndex, label).toBe(t.modelIndex);
        // Links: slot pattern 1,0,0,1 in the middle, the port number on the first, an open end on the last.
        expect(links(m), `${label} record ${i}`).toEqual(links(t));
        expect(m.inputObjIdx === ours[0].index, `${label} record ${i}`).toBe(t.inputObjIdx === sampleStation.index);
        expect(m.outputObjIdx === -1, `${label} record ${i}`).toBe(t.outputObjIdx === -1);
        if (i < 2) expect(m.outputObjIdx, label).toBe(mine[i + 1].index);
        // Position relative to the station centre, and heading.
        const tol = i === 1 ? 0.06 : 0.05;
        near(m.localOffset[0] - ours[0].localOffset[0], t.localOffset[0] - sampleStation.localOffset[0], tol, `${label} record ${i} x`);
        near(m.localOffset[1] - ours[0].localOffset[1], t.localOffset[1] - sampleStation.localOffset[1], tol, `${label} record ${i} y`);
        near(m.localOffset[2], t.localOffset[2], 0.05, `${label} record ${i} z`);
        expect(headingGap(m.yaw, t.yaw), `${label} record ${i} yaw`).toBeLessThan(2);
        expect(headingGap(m.yaw2, m.yaw)).toBe(0);
      });
      // Stub spacing from the station centre along the port's normal: ~2.15 tiles at the port, ~3.02 at the second
      // record, 4 at the lattice.
      const [dx, dy] = ports[port].dir;
      const normal = (r: BlueprintBuilding, c: BlueprintBuilding) => (r.localOffset[0] - c.localOffset[0]) * dx + (r.localOffset[1] - c.localOffset[1]) * dy;
      near(normal(mine[0], ours[0]), 2.15, 0.05, `${label} port stub`);
      // The game puts the second record ~0.87 tile past the port; the builder uses the midpoint to the lattice, 3.07.
      near(normal(mine[1], ours[0]), 3.02, 0.06, `${label} second stub`);
      near(normal(mine[2], ours[0]), 4, 1e-3, `${label} lattice node`); // float32 on the wire
      near(normal(theirs[0], sampleStation), 2.15, 0.02, `${label} sample port stub`);
      near(normal(theirs[1], sampleStation), 3.02, 0.03, `${label} sample second stub`);
      near(normal(theirs[2], sampleStation), 4, 0.01, `${label} sample lattice node`);
    });
  });

  test('capsule export: every belt to assembler sorter has the same fields, yaw and ends as the game wrote', () => {
    const bp = loadBlueprintSample('capsule-production-v2-reform-0.10.33.txt');
    const pairs = assemblerSorters(bp, 2304);
    expect(pairs.length).toBeGreaterThanOrEqual(20);
    expect(pairs.some((p) => p.kind === 'input') && pairs.some((p) => p.kind === 'output')).toBe(true);

    for (const { sorter: theirs, assembler: theirAsm, kind, slot, span } of pairs) {
      const label = `sorter ${theirs.index} (${kind}, slot ${slot}, span ${span})`;
      const asm = { id: 1, itemId: 2304, x: theirAsm.localOffset[0], y: theirAsm.localOffset[1], z: 0, yaw: 0 as const };
      const info = slotInfos(asm, data.building(2304)!)[slot];
      // A three-node belt across the slot's row, tapped in the middle at the span's lattice point.
      const tap = sorterTapPoint(info, span as 1 | 2 | 3);
      const lateral: [number, number] = [Math.abs(info.dir[1]), Math.abs(info.dir[0])];
      const belt = beltOf(
        1,
        [
          [tap.x - lateral[0], tap.y - lateral[1]],
          [tap.x, tap.y],
          [tap.x + lateral[0], tap.y + lateral[1]],
        ],
        { tierItemId: 2003 },
      );
      const onBelt = { kind: 'belt', beltId: 1, node: 1 } as const;
      const onAsm = { kind: 'building', buildingId: 1, slot } as const;
      const sorter = sorterOf({
        tierItemId: 2013,
        span: span as 1 | 2 | 3,
        pick: kind === 'input' ? onBelt : onAsm,
        drop: kind === 'input' ? onAsm : onBelt,
      });
      const recs = records(layoutOf({ buildings: [asm], belts: [belt], sorters: [sorter] }));
      const mine = recs[recs.length - 1];
      const mineAsm = recs[0];

      // Fields.
      expect(mine.itemId, label).toBe(theirs.itemId);
      expect(mine.modelIndex, label).toBe(theirs.modelIndex);
      expect(mine.inputFromSlot, label).toBe(theirs.inputFromSlot);
      expect(mine.inputFromSlot, label).toBe(kind === 'input' ? -1 : slot);
      expect(mine.outputToSlot, label).toBe(theirs.outputToSlot);
      expect(mine.outputToSlot, label).toBe(kind === 'input' ? slot : -1);
      expect([mine.outputFromSlot, mine.inputToSlot], label).toEqual([0, 1]);
      expect([mine.outputFromSlot, mine.inputToSlot], label).toEqual([theirs.outputFromSlot, theirs.inputToSlot]);
      expect(Array.from(mine.parameters), label).toEqual(Array.from(theirs.parameters));
      expect(Array.from(mine.parameters), label).toEqual([span]);
      expect(mine.filterId, label).toBe(theirs.filterId);
      // Links: the assembler on the building side, a belt record on the other.
      const [buildingSide, beltSide] = kind === 'input' ? [mine.outputObjIdx, mine.inputObjIdx] : [mine.inputObjIdx, mine.outputObjIdx];
      expect(recs[buildingSide].itemId, label).toBe(2304);
      expect(recs[beltSide].itemId, label).toBe(2003);

      // Heading: pick toward drop.
      expect(headingGap(mine.yaw, theirs.yaw), `${label} yaw`).toBeLessThan(0.5);
      expect(headingGap(mine.yaw2, theirs.yaw2), `${label} yaw2`).toBeLessThan(0.5);
      // Ends, relative to the assembler: building end at the slot, belt end at the slot's lateral coordinate.
      for (const [m, t, end] of [
        [mine.localOffset, theirs.localOffset, 'pick'],
        [mine.localOffset2, theirs.localOffset2, 'drop'],
      ] as const) {
        near(m[0] - mineAsm.localOffset[0], t[0] - theirAsm.localOffset[0], 0.05, `${label} ${end} x`);
        near(m[1] - mineAsm.localOffset[1], t[1] - theirAsm.localOffset[1], 0.05, `${label} ${end} y`);
        near(m[2], t[2], 0.05, `${label} ${end} z`);
      }
    }
  });

  test('capsule export: every flat quarter-turn belt node gets the yaw the game wrote, corners included', () => {
    const recs = loadBlueprintSample('capsule-production-v2-reform-0.10.33.txt').body.buildings;
    const isBelt = (r: BlueprintBuilding) => r.itemId === 2003;
    const flat = (a: BlueprintBuilding, b: BlueprintBuilding) => Math.abs(a.localOffset[2] - b.localOffset[2]) < 0.1;
    // Whole quarter turns only; the sample also has a few curved runs with fractional positions.
    const quarter = (v: number) => Math.abs(v - Math.round(v / 90) * 90) < 0.5;
    let straight = 0;
    let corners = 0;
    for (const mid of recs.filter(isBelt)) {
      const next = recs[mid.outputObjIdx];
      const prevs = recs.filter((r) => isBelt(r) && r.outputObjIdx === mid.index);
      if (!next || !isBelt(next) || prevs.length !== 1) continue;
      const prev = prevs[0];
      if (!flat(prev, mid) || !flat(mid, next)) continue;
      const hin = headingDeg(mid.localOffset[0] - prev.localOffset[0], mid.localOffset[1] - prev.localOffset[1]);
      const hout = headingDeg(next.localOffset[0] - mid.localOffset[0], next.localOffset[1] - mid.localOffset[1]);
      if (!quarter(hin) || !quarter(hout)) continue;
      const nodes = [prev, mid, next].map((r): [number, number] => [Math.round(r.localOffset[0]), Math.round(r.localOffset[1])]);
      const built = records(layoutOf({ belts: [beltOf(1, nodes, { tierItemId: 2003 })] }))[1];
      expect(headingGap(built.yaw, mid.yaw), `belt record ${mid.index}`).toBeLessThan(3);
      if (headingGap(hin, hout) > 45) corners++;
      else straight++;
    }
    expect(corners).toBeGreaterThanOrEqual(8);
    expect(straight).toBeGreaterThanOrEqual(100);
  });
});

describe('M0 test blueprint (scripts/emit-test-blueprint.ts)', () => {
  const layout = buildM0Layout(data);
  const placed = (id: number) => layout.buildings.find((b) => b.id === id)!;
  const def = (itemId: number) => data.building(itemId)!;
  const smelters = layout.buildings.filter((b) => b.itemId === 2302);
  const towers = layout.buildings.filter((b) => b.itemId === 2201);
  const [ore, ingot] = layout.belts;

  test('builds a blueprint that decodes and round-trips', () => {
    const str = buildM0Blueprint(data, NOW);
    const bp = decodeBlueprint(str);
    expect(encodeBlueprint(bp)).toBe(str);
    expect(bp.header.icons[0]).toBe(1101);
    expect(bp.header.shortDesc).toBe('M0 smelter row');
    expect(bp.header.desc).toContain('geometry: approximate');
    // ILS + 3 smelters + 3 towers; ore belt 2 stubs + 11 nodes; ingot belt 14 nodes + 2 stubs; 6 sorters.
    expect(bp.body.buildings).toHaveLength(7 + 13 + 16 + 6);
    expect(layout.meta.geometrySource).toBe('approximate');
  });

  test('has the ILS, three iron-ingot smelters, six Mk.I sorters and two Mk.I belts', () => {
    expect(placed(1).itemId).toBe(2104);
    expect(placed(1).station?.slots).toEqual([
      { itemId: 1001, localLogic: 2, remoteLogic: 2, max: 10000 },
      { itemId: 1101, localLogic: 1, remoteLogic: 1, max: 10000 },
    ]);
    expect(smelters.map((b) => b.recipeId)).toEqual([1, 1, 1]);
    expect(layout.sorters).toHaveLength(6);
    expect(layout.sorters.every((s) => s.tierItemId === 2011 && s.span === 1)).toBe(true);
    expect(layout.sorters.filter((s) => s.filterItemId === 1101)).toHaveLength(3);
    expect(layout.belts.map((b) => b.tierItemId)).toEqual([2001, 2001]);
    expect(ore.nodes).toHaveLength(11);
  });

  test('the ILS ports: port 3 outputs Iron Ore, port 4 takes ingots back', () => {
    const { ports } = placed(1).station!;
    expect(ports[3]).toEqual({ dir: 1, storageIdx: 1 });
    expect(ports[4]).toEqual({ dir: 2, storageIdx: 0 });
    expect(ore.source).toEqual({ buildingId: 1, port: 3 });
    expect(ingot.sink).toEqual({ kind: 'port', buildingId: 1, port: 4 });
  });

  test('every hand-placed belt end and tap node is the slot-cell rule applied to the fixture geometry', () => {
    const ilsDef = def(2104);
    const port3 = slotCell(placed(1), ilsDef, ilsDef.geometry.ports[3]);
    const port4 = slotCell(placed(1), ilsDef, ilsDef.geometry.ports[4]);
    expect(port3.dir).toEqual([-1, 0]);
    expect(port3.firstOutside).toEqual({ x: -4, y: 1 });
    expect(port4.firstOutside).toEqual({ x: -4, y: 0 });
    expect(ore.nodes[0]).toEqual({ ...port3.firstOutside, z: 0 });
    expect(ingot.nodes[ingot.nodes.length - 1]).toEqual({ ...port4.firstOutside, z: 0 });

    const smelterDef = def(2302);
    for (const s of layout.sorters) {
      const onBuilding = s.pick.kind === 'building' ? s.pick : s.drop;
      const onBelt = s.pick.kind === 'belt' ? s.pick : s.drop;
      if (onBuilding.kind !== 'building' || onBelt.kind !== 'belt') throw new Error('expected a belt-building sorter');
      const cell = slotCell(placed(onBuilding.buildingId), smelterDef, smelterDef.geometry.slots[onBuilding.slot]);
      const belt = layout.belts.find((b) => b.id === onBelt.beltId)!;
      expect(belt.nodes[onBelt.node], `sorter ${s.id}`).toEqual({ ...cell.firstOutside, z: 0 });
    }
  });

  test('every sorter is a straight 1.4 m hop between a belt and its smelter slot', () => {
    for (const s of layout.sorters) {
      const { pick, drop } = sorterEnds(s, layout, data);
      const metres = Math.hypot(drop.x - pick.x, drop.y - pick.y) * TILE;
      // Two tiles from the centre line to the belt row, less the slot's 1.11 m offset.
      expect(metres, `sorter ${s.id}`).toBeCloseTo(2 * TILE - 1.11, 9);
      expect(metres).toBeGreaterThan(1);
      expect(metres).toBeLessThan(5.5);
      expect(Math.abs(drop.x - pick.x), `sorter ${s.id} skew`).toBeLessThan(1e-9);
    }
  });

  test('nothing is placed inside a building footprint it should clear', () => {
    const clear = (x: number, y: number, except: number[] = []) =>
      layout.buildings
        .filter((b) => !except.includes(b.id) && def(b.itemId).kind !== 'powerNode')
        .every((b) => !insideFootprint(b, def(b.itemId), x, y));
    // Belt nodes (the port cells are outside the ILS by construction) and towers.
    for (const belt of layout.belts) for (const n of belt.nodes) expect(clear(n.x, n.y), `belt ${belt.id} node ${n.x},${n.y}`).toBe(true);
    for (const t of towers) expect(clear(t.x, t.y), `tower ${t.id}`).toBe(true);
    // The smelters do not overlap each other (footprints 2.39 tiles wide on a 3-tile pitch).
    const [a, b, c] = smelters;
    expect(b.x - a.x).toBeLessThanOrEqual(-3);
    expect(c.x - b.x).toBeLessThanOrEqual(-3);
  });

  test('Tesla towers cover every consumer, and the towers connect to each other', () => {
    const node = def(2201).power.node!;
    const point = (t: PlacedBuilding) => prefabToGrid(t, node.powerPoint);
    const metres = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) * TILE;
    const covered = (p: { x: number; y: number }) => towers.some((t) => metres(p, point(t)) <= node.coverRadius);

    for (const b of layout.buildings.filter((x) => def(x.itemId).power.consumer)) expect(covered(b), `building ${b.id}`).toBe(true);
    for (const s of layout.sorters) {
      const { pick, drop } = sorterEnds(s, layout, data);
      expect(covered({ x: (pick.x + drop.x) / 2, y: (pick.y + drop.y) / 2 }), `sorter ${s.id}`).toBe(true);
    }
    for (let i = 1; i < towers.length; i++) {
      expect(metres(point(towers[i - 1]), point(towers[i])), `towers ${i - 1}-${i}`).toBeLessThanOrEqual(node.connectDistance);
    }
  });

  test('writeM0Blueprint creates the directory, writes the string and the file decodes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm0-'));
    try {
      const out = join(dir, 'nested', 'm0-smelter-row.txt');
      const str = writeM0Blueprint(out, NOW);
      const text = readFileSync(out, 'utf8');
      expect(text.trim()).toBe(str);
      expect(decodeBlueprint(text).body.buildings.length).toBeGreaterThan(40);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
