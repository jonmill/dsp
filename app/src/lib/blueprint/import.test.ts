import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildM0Layout } from '../../../scripts/emit-test-blueprint';
import { loadBlueprintSample } from '../../../test/fixtures/blueprintSamples';
import type { ProductionPlan } from '../calc';
import { GameDataIndex, parseGameData } from '../data';
import type { TechEffects } from '../data';
import { portInfos } from '../geometry';
import type {
  BeltPath,
  Endpoint,
  GridPoint,
  Layout,
  PlacedBuilding,
  Sorter,
  StationConfig,
  StationPortConfig,
} from '../geometry';
import { DEFAULT_SOLVE_OPTIONS, solve } from '../layout/solver';
import { data as kitData, effects as kitEffects, planFor, SMELTER } from '../layout/testkit';
import { runSimulation } from '../validate';
import { layoutToBlueprintString } from './build';
import { decodeBlueprint } from './codec';
import { blueprintToLayout, regressionPlanFor } from './import';
import type { Blueprint } from './model';

const fixturePath = fileURLToPath(new URL('../../../../data/fixture/dsp-fixture.json', import.meta.url));
const data = new GameDataIndex(parseGameData(JSON.parse(readFileSync(fixturePath, 'utf8')), 'dsp-fixture.json'));

const NOW = new Date(2026, 0, 2, 3, 4, 5);
const OPTS = { shortDesc: 'test', desc: 'hand-made', now: NOW };

// ---------------------------------------------------------------------------------------------
// Layout builders (the Task 9 test layouts)

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

/**
 * Belt 1 merges into the middle of belt 2 from the west; belt 2 runs north past it. `onTarget`: belt 1's last node is on
 * the node it merges into instead of beside it (both pass the geometry check).
 */
function mergeLayout(onTarget = false): Layout {
  return layoutOf({
    belts: [
      beltOf(1, onTarget ? [[0, 0], [1, 0], [2, 0]] : [[0, 0], [1, 0]], { sink: { kind: 'belt', beltId: 2, node: 1 } }),
      beltOf(2, [[2, -1], [2, 0], [2, 1]]),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Comparing a layout with its import

const anchorOf = (l: Layout): GridPoint => {
  if (l.buildings.length > 0) return l.buildings[0];
  return l.belts[0].nodes[0];
};

const near = (a: number, b: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThan(1e-3);

/**
 * The imported layout reproduces the original, up to renumbered ids and the integer shift the builder applied.
 * Buildings, belts and sorters are matched by position in their lists (the importer keeps record order).
 */
function expectSameLayout(original: Layout, imported: Layout): void {
  const a0 = anchorOf(original);
  const b0 = anchorOf(imported);
  const dx = Math.round(b0.x - a0.x);
  const dy = Math.round(b0.y - a0.y);
  near(b0.x - a0.x, dx, 'the shift in x is an integer');
  near(b0.y - a0.y, dy, 'the shift in y is an integer');
  near(b0.z, a0.z, 'the anchor height');
  const same = (p: GridPoint, q: GridPoint, what: string) => {
    near(q.x - p.x, dx, `${what} x`);
    near(q.y - p.y, dy, `${what} y`);
    near(q.z, p.z, `${what} z`);
  };

  expect(imported.buildings).toHaveLength(original.buildings.length);
  const buildingId = new Map<number, number>();
  original.buildings.forEach((b, i) => {
    const got = imported.buildings[i];
    const what = `building ${b.id}`;
    buildingId.set(b.id, got.id);
    expect(got.itemId, what).toBe(b.itemId);
    expect(got.yaw, what).toBe(b.yaw);
    expect(got.recipeId, what).toBe(b.recipeId);
    same(b, got, what);
    if (b.station) expect(got.station, what).toEqual(b.station);
    else expect(got.station, what).toBeUndefined();
    if (b.recipeId !== undefined) expect(got.prolifMode ?? 0, what).toBe(b.prolifMode ?? 0);
  });

  expect(imported.belts).toHaveLength(original.belts.length);
  const beltId = new Map<number, number>();
  original.belts.forEach((belt, i) => beltId.set(belt.id, imported.belts[i].id));
  original.belts.forEach((belt, i) => {
    const got = imported.belts[i];
    const what = `belt ${belt.id}`;
    expect(got.tierItemId, what).toBe(belt.tierItemId);
    expect(got.nodes, what).toHaveLength(belt.nodes.length);
    belt.nodes.forEach((p, n) => same(p, got.nodes[n], `${what} node ${n}`));
    expect(got.source, what).toEqual(belt.source && { buildingId: buildingId.get(belt.source.buildingId), port: belt.source.port });
    const sink = belt.sink;
    if (sink?.kind === 'port') {
      expect(got.sink, what).toEqual({ kind: 'port', buildingId: buildingId.get(sink.buildingId), port: sink.port });
    } else if (sink?.kind === 'belt') {
      expect(got.sink, what).toEqual({ kind: 'belt', beltId: beltId.get(sink.beltId), node: sink.node });
    } else {
      expect(got.sink, what).toBeUndefined();
    }
  });

  const endpoint = (e: Endpoint): Endpoint =>
    e.kind === 'building'
      ? { kind: 'building', buildingId: buildingId.get(e.buildingId) as number, slot: e.slot }
      : { kind: 'belt', beltId: beltId.get(e.beltId) as number, node: e.node };
  expect(imported.sorters).toHaveLength(original.sorters.length);
  original.sorters.forEach((s, i) => {
    const got = imported.sorters[i];
    const what = `sorter ${s.id}`;
    expect(got.tierItemId, what).toBe(s.tierItemId);
    expect(got.filterItemId, what).toBe(s.filterItemId);
    expect(got.span, what).toBe(s.span);
    expect(got.pick, what).toEqual(endpoint(s.pick));
    expect(got.drop, what).toEqual(endpoint(s.drop));
  });

  expect(imported.meta.gameVersion).toBe(original.meta.gameVersion);
  expect(imported.meta.planTargetItemId).toBe(original.meta.planTargetItemId);
  expect(imported.meta.geometrySource).toBe(original.meta.geometrySource);
}

function roundTrip(layout: Layout) {
  const bp = decodeBlueprint(layoutToBlueprintString(layout, data, OPTS));
  return { bp, ...blueprintToLayout(bp, data) };
}

/** `bp` with its records in a different order: record `n` of the result is record `order[n]` of `bp`, links remapped. */
function reorder(bp: Blueprint, order: number[]): Blueprint {
  const at = new Map(order.map((old, n) => [old, n]));
  const link = (v: number) => (v < 0 ? v : (at.get(v) as number));
  const copy = structuredClone(bp);
  copy.body.buildings = order.map((old, n) => {
    const r = bp.body.buildings[old];
    return { ...structuredClone(r), index: n, outputObjIdx: link(r.outputObjIdx), inputObjIdx: link(r.inputObjIdx) };
  });
  return copy;
}

// ---------------------------------------------------------------------------------------------

describe('blueprintToLayout: round trip of layoutToBlueprint', () => {
  test('the M0 smelter row (station with source and sink ports, six sorters, three towers)', () => {
    const original = buildM0Layout(data);
    const { layout, warnings } = roundTrip(original);
    expect(warnings).toEqual([]);
    expectSameLayout(original, layout);
    // The port stubs are gone: 11 nodes on the ore belt, 14 on the return belt.
    expect(layout.belts.map((b) => b.nodes.length)).toEqual([11, 14]);
  });

  test('the rich layout of the builder tests', () => {
    const original = richLayout();
    const { layout, warnings } = roundTrip(original);
    expect(warnings).toEqual([]);
    expectSameLayout(original, layout);
    expect(layout.belts[0].source).toEqual({ buildingId: layout.buildings[0].id, port: 3 });
    expect(layout.belts[1].sink).toEqual({ kind: 'port', buildingId: layout.buildings[0].id, port: 4 });
    expect(layout.sorters[0].drop).toEqual({ kind: 'building', buildingId: layout.buildings[1].id, slot: 2 });
    expect(layout.sorters[1].pick).toEqual({ kind: 'building', buildingId: layout.buildings[1].id, slot: 8 });
  });

  test.each([
    { name: 'beside it', onTarget: false },
    { name: 'on it', onTarget: true },
  ])('a belt that merges into the middle of another belt, ending $name', ({ onTarget }) => {
    const original = mergeLayout(onTarget);
    const { layout, warnings } = roundTrip(original);
    expect(warnings).toEqual([]);
    expectSameLayout(original, layout);
    expect(layout.belts[0].sink).toEqual({ kind: 'belt', beltId: layout.belts[1].id, node: 1 });
  });

  // Records 0, 1 are the joiner, 2, 3, 4 the belt it merges into at record 3. In neither order does the record before the
  // merge target feed it, so the straight run is found by direction. Scrambled puts the joiner's last record first.
  test.each([
    { name: 'reversed', order: [4, 3, 2, 1, 0], onTarget: false },
    { name: 'scrambled', order: [1, 0, 4, 3, 2], onTarget: false },
    // The joiner's last node (record 2 of 6) sits on the target; it arrives from no direction.
    { name: 'scrambled, ending on the target', order: [2, 1, 0, 5, 4, 3], onTarget: true },
  ])('the merge does not depend on the record order ($name)', ({ order, onTarget }) => {
    const { bp } = roundTrip(mergeLayout(onTarget));
    const { layout, warnings } = blueprintToLayout(reorder(bp, order), data);
    expect(warnings).toEqual([]);
    expect(layout.belts).toHaveLength(2);
    const through = layout.belts.find((b) => b.nodes.every((n) => n.x === b.nodes[0].x)) as BeltPath;
    const joiner = layout.belts.find((b) => b !== through) as BeltPath;
    expect(through.nodes.map((n) => [n.x - through.nodes[0].x, n.y - through.nodes[0].y])).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(joiner.sink).toEqual({ kind: 'belt', beltId: through.id, node: 1 });
    expect(through.sink).toBeUndefined();
  });

  test('a belt with a vertical lift and corners keeps its nodes and heights', () => {
    const original = layoutOf({
      belts: [beltOf(1, [[0, 0, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1], [2, 1, 1], [2, 2, 1]], { tierItemId: 2003 })],
    });
    const { layout, warnings } = roundTrip(original);
    expect(warnings).toEqual([]);
    expectSameLayout(original, layout);
  });

  test('building yaws, a lab, a station without configuration and prolifMode survive', () => {
    const original = layoutOf({
      buildings: [
        smelter({ id: 1, yaw: 270, prolifMode: 1 }),
        smelter({ id: 2, x: 5, y: 5, yaw: 90, recipeId: 2, prolifMode: 0 }),
        { id: 3, itemId: 2303, x: 10, y: 0, z: 0, yaw: 180 },
        tower(4, 7, 7),
        ils({ id: 5, x: -10, y: 3, yaw: 90 }),
      ],
    });
    const { layout, warnings } = roundTrip(original);
    expect(warnings).toEqual([]);
    expectSameLayout(original, layout);
    expect(layout.buildings[0].prolifMode).toBe(1);
    expect(layout.buildings[2].recipeId).toBeUndefined();
  });

  test('station slots with a gap keep their positions, so a port keeps pointing at its storage', () => {
    const original = layoutOf({
      buildings: [
        ils({
          station: station({
            slots: [
              { itemId: 1001, localLogic: 2, remoteLogic: 2, max: 10000 },
              { itemId: 0, localLogic: 0, remoteLogic: 0, max: 0 },
              { itemId: 1101, localLogic: 1, remoteLogic: 1, max: 5000 },
            ],
            ports: ports12({ 0: { dir: 1, storageIdx: 3 }, 7: { dir: 2, storageIdx: 0 } }),
            chargePerTick: 200000,
            pilerCount: 3,
          }),
        }),
      ],
    });
    const { layout, warnings } = roundTrip(original);
    expect(warnings).toEqual([]);
    expectSameLayout(original, layout);
  });

  test('a one-node belt on every port of a station', () => {
    const everyPort = ports12(Object.fromEntries(Array.from({ length: 12 }, (_, p) => [p, { dir: 1 as const, storageIdx: 1 }])));
    const station12 = ils({
      station: station({ slots: [{ itemId: 1001, localLogic: 2, remoteLogic: 2, max: 10 }], ports: everyPort }),
    });
    const original = layoutOf({
      buildings: [station12],
      belts: portInfos(station12, data.building(2104)!).map((p, i) =>
        beltOf(i + 1, [[p.firstOutside.x, p.firstOutside.y]], { tierItemId: 2002, source: { buildingId: 1, port: p.index } }),
      ),
    });
    const { layout, warnings } = roundTrip(original);
    expect(warnings).toEqual([]);
    expectSameLayout(original, layout);
    expect(layout.belts.map((b) => b.source?.port)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('the output of the solver for 3 Iron Ingots/s (Task 24 plan (a))', async () => {
    const plan = await planFor({
      targetItemId: 1101,
      finalFacilityItemId: SMELTER,
      quantity: { kind: 'rate', perSecond: 3 },
      suppliedItemIds: new Set([1001]),
    });
    const result = solve(
      plan,
      kitData,
      kitEffects,
      { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1, seed: 7, simWarmupTicks: 1200, simMeasureTicks: 3600 },
      () => {},
      () => {},
      () => false,
    );
    expect(result.layout, result.failures.join('; ')).not.toBeNull();
    const original = result.layout as Layout;
    const bp = decodeBlueprint(layoutToBlueprintString(original, kitData, OPTS));
    const imported = blueprintToLayout(bp, kitData);
    expect(imported.warnings).toEqual([]);
    expectSameLayout(original, imported.layout);
    expect(original.belts.length).toBeGreaterThan(0);
    expect(original.sorters.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('blueprintToLayout: what the layout does not store', () => {
  test('positions are blueprint-local: the builder shifted x = -3.6 to 0.4', () => {
    const { layout } = roundTrip(layoutOf({ buildings: [tower(1, -3.6, 1), tower(2, 5, 7.5)] }));
    expect(layout.buildings[0].x).toBeCloseTo(0.4, 5);
    expect(layout.buildings[0].y).toBeCloseTo(0, 5);
    expect(layout.buildings[1].x).toBeCloseTo(9, 5);
    expect(layout.buildings[1].y).toBeCloseTo(6.5, 5);
  });

  test('ids are the record indexes, belts take the index of their first record', () => {
    const { layout } = roundTrip(richLayout());
    expect(layout.buildings.map((b) => b.id)).toEqual([0, 1, 2]);
    // 3 buildings, then the ore belt (2 stubs + 6 nodes), the return belt (9 nodes + 2 stubs), then the sorters.
    expect(layout.belts.map((b) => b.id)).toEqual([3, 11]);
    expect(layout.sorters.map((s) => s.id)).toEqual([22, 23]);
  });

  test('the carried item of a belt comes from the station port it leaves or from the sorter filters on it', () => {
    const { layout } = roundTrip(buildM0Layout(data));
    expect(layout.belts.map((b) => b.itemId)).toEqual([1001, 1101]);
    const { layout: bare } = roundTrip(layoutOf({ belts: [beltOf(1, [[0, 0], [1, 0]])] }));
    expect(bare.belts[0].itemId).toBe(0);
  });

  test('planned rates are unknown and read 0; the header supplies the version and target item', () => {
    const { layout } = roundTrip(buildM0Layout(data));
    expect(layout.belts.every((b) => b.plannedRate === 0)).toBe(true);
    expect(layout.sorters.every((s) => s.plannedRate === 0)).toBe(true);
    expect(layout.meta).toEqual({
      geometrySource: 'approximate',
      gameVersion: data.data.meta.gameVersion,
      planTargetItemId: 1101,
      planTargetRate: 0,
    });
  });
});

describe('blueprintToLayout: real exports', () => {
  test('the interstellar station sample: its settings and a one-node belt on every port', () => {
    const bp = loadBlueprintSample('ils-configured-0.9.24.txt');
    const { layout, warnings } = blueprintToLayout(bp, data);
    expect(warnings).toEqual([]);
    expect(layout.buildings).toHaveLength(1);
    const cfg = layout.buildings[0].station as StationConfig;
    expect(cfg.slots.map((s) => [s.itemId, s.localLogic, s.remoteLogic, s.max])).toEqual(
      [6001, 6002, 6003, 6004, 6005].map((id) => [id, 1, 1, 10000]),
    );
    expect(cfg.ports.map((p) => p.dir)).toEqual(Array(12).fill(1));
    expect(cfg.ports.map((p) => p.storageIdx)).toEqual([2, 2, 1, 5, 5, 1, 4, 4, 1, 3, 3, 1]);
    expect(cfg.chargePerTick).toBe(1000000);
    // 12 chains of 3 records: port stub, second stub and the lattice node.
    expect(layout.belts).toHaveLength(12);
    expect(layout.belts.every((b) => b.nodes.length === 1 && b.tierItemId === 2002)).toBe(true);
    expect(layout.belts.map((b) => b.source?.port).sort((x, y) => (x as number) - (y as number))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const b of layout.belts) expect(b.source?.buildingId).toBe(layout.buildings[0].id);
    expect(layout.belts.every((b) => b.itemId >= 6001 && b.itemId <= 6005)).toBe(true);
  });

  test('the capsule sample: unknown kinds are skipped with warnings, nothing throws', () => {
    const bp = loadBlueprintSample('capsule-production-v2-reform-0.10.33.txt');
    const { layout, warnings } = blueprintToLayout(bp, data);
    // 8 assemblers (four each on recipes 142 and 143), 4 towers.
    const assemblers = layout.buildings.filter((b) => b.itemId === 2304);
    expect(assemblers.map((b) => b.recipeId).sort()).toEqual([142, 142, 142, 142, 143, 143, 143, 143]);
    expect(layout.buildings.filter((b) => b.itemId === 2201)).toHaveLength(4);
    expect(layout.buildings).toHaveLength(12);
    // No station, so no stubs: each of the 247 belt records is a node of exactly one path. All 36 sorters import.
    expect(layout.belts.reduce((sum, b) => sum + b.nodes.length, 0)).toBe(247);
    expect(layout.belts.length).toBeGreaterThanOrEqual(10);
    expect(layout.sorters).toHaveLength(36);

    const text = warnings.join('\n');
    for (const skipped of [/9 x Splitter/, /9 x Depot MK\.I/, /9 x Logistics Distributor/, /1 x Traffic Monitor/, /8 x Spray Coater/]) {
      expect(text).toMatch(skipped);
    }
    // Aggregated, not one line per record.
    expect(warnings.filter((w) => /^\d+ x /.test(w))).toHaveLength(5);
  });

  test('the capsule sample keeps fractional and curved belt nodes', () => {
    const bp = loadBlueprintSample('capsule-production-v2-reform-0.10.33.txt');
    const { layout } = blueprintToLayout(bp, data);
    const fractional = layout.belts.flatMap((b) => b.nodes).filter((n) => Math.abs(n.x - Math.round(n.x)) > 0.05 || Math.abs(n.y - Math.round(n.y)) > 0.05);
    expect(fractional.length).toBeGreaterThan(0);
  });

  test('the capsule sample: every assembler sorter keeps its slot and its belt node', () => {
    const bp = loadBlueprintSample('capsule-production-v2-reform-0.10.33.txt');
    const { layout } = blueprintToLayout(bp, data);
    const onAssembler = layout.sorters.filter((s) => s.pick.kind === 'building' || s.drop.kind === 'building');
    expect(onAssembler.length).toBeGreaterThanOrEqual(20);
    for (const s of onAssembler) {
      const [b, other] = s.pick.kind === 'building' ? [s.pick, s.drop] : [s.drop as Extract<Endpoint, { kind: 'building' }>, s.pick];
      expect(layout.buildings.some((x) => x.id === b.buildingId && x.itemId === 2304)).toBe(true);
      expect(b.slot).toBeGreaterThanOrEqual(0);
      expect(other.kind).toBe('belt');
      if (other.kind === 'belt') {
        const belt = layout.belts.find((x) => x.id === other.beltId) as BeltPath;
        expect(belt.nodes[other.node]).toBeDefined();
      }
    }
  });

  test('the sample with a splitter and a Mk.I belt chain imports what it can', () => {
    const bp = loadBlueprintSample('mixed-16-buildings-0.9.24.txt');
    const { layout, warnings } = blueprintToLayout(bp, data);
    expect(layout.buildings.map((b) => b.itemId).sort()).toEqual([2104, 2201, 2302]);
    expect(layout.buildings.find((b) => b.itemId === 2302)?.recipeId).toBe(3);
    expect(warnings.join('\n')).toMatch(/1 x Splitter/);
    // The two belt ends that met the splitter are left open; the ILS belt keeps its source and loses two stubs.
    expect(warnings.join('\n')).toMatch(/2 belt ends link to skipped buildings/);
    expect(layout.belts.map((b) => b.nodes.length)).toEqual([3, 2, 4]);
    expect(layout.belts[2].source).toEqual({ buildingId: 10, port: 8 });
    // The Mk.I sorter picks from the belt (node 3 of the ILS chain) and drops into the smelter's slot 10.
    expect(layout.sorters).toHaveLength(1);
    expect(layout.sorters[0]).toMatchObject({ tierItemId: 2011, span: 1, drop: { kind: 'building', buildingId: 3, slot: 10 } });
  });
});

describe('blueprintToLayout: records it cannot place', () => {
  const rich = () => roundTrip(richLayout()).bp;

  test('an item that is not a building in GameData is skipped with a warning', () => {
    const bp = rich();
    bp.body.buildings[2].itemId = 9999; // the Tesla tower
    const { layout, warnings } = blueprintToLayout(bp, data);
    expect(layout.buildings).toHaveLength(2);
    expect(warnings.join('\n')).toMatch(/item 9999/);
  });

  test('a belt chain that ends at a skipped building ends open, with a warning', () => {
    const bp = rich();
    bp.body.buildings[0].itemId = 2020; // the ILS becomes a splitter, which the planner does not model
    const { layout, warnings } = blueprintToLayout(bp, data);
    expect(layout.buildings.map((b) => b.itemId)).toEqual([2302, 2201]);
    expect(layout.belts).toHaveLength(2);
    expect(layout.belts[0].source).toBeUndefined();
    expect(layout.belts[1].sink).toBeUndefined();
    // Without a station there is nothing to fold, so every record stays a node.
    expect(layout.belts.map((b) => b.nodes.length)).toEqual([8, 11]);
    expect(warnings.join('\n')).toMatch(/1 x Splitter/);
  });

  test('a sorter whose end is a skipped building is skipped with a warning', () => {
    const bp = rich();
    const smelterRecord = bp.body.buildings[1];
    smelterRecord.itemId = 2020;
    const { layout, warnings } = blueprintToLayout(bp, data);
    expect(layout.sorters).toHaveLength(0);
    expect(warnings.filter((w) => /^sorter/.test(w))).toHaveLength(2);
  });

  test('a sorter end that links nothing is skipped with a warning', () => {
    const bp = rich();
    const sorter = bp.body.buildings[bp.body.buildings.length - 1];
    sorter.outputObjIdx = -1;
    const { layout, warnings } = blueprintToLayout(bp, data);
    expect(layout.sorters).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/sorter .*drop/);
  });

  test('a building yaw off the four quarter turns snaps to the nearest, with a warning', () => {
    const bp = rich();
    bp.body.buildings[1].yaw = 40;
    bp.body.buildings[1].yaw2 = 40;
    bp.body.buildings[2].yaw = 359.8;
    const { layout, warnings } = blueprintToLayout(bp, data);
    expect(layout.buildings[1].yaw).toBe(0);
    expect(layout.buildings[2].yaw).toBe(0);
    expect(warnings.filter((w) => /yaw/.test(w))).toHaveLength(1); // 359.8 is within a degree: no warning
  });

  test('a station port number outside 0..11 leaves the belt end open, with a warning', () => {
    const bp = rich();
    const head = bp.body.buildings.find((r) => r.inputObjIdx === 0) as Blueprint['body']['buildings'][number];
    head.inputFromSlot = 14;
    const { layout, warnings } = blueprintToLayout(bp, data);
    expect(layout.belts[0].source).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/port 14/);
  });
});

describe('blueprintToLayout: structurally broken links throw', () => {
  const rich = () => roundTrip(richLayout()).bp;

  test('a belt whose output record does not exist', () => {
    const bp = rich();
    bp.body.buildings[5].outputObjIdx = 999;
    expect(() => blueprintToLayout(bp, data)).toThrow(/record 5.*outputObjIdx 999/);
  });

  test('a belt fed by a record that does not exist', () => {
    const bp = rich();
    bp.body.buildings[4].inputObjIdx = 77;
    expect(() => blueprintToLayout(bp, data)).toThrow(/record 4.*inputObjIdx 77/);
  });

  test('a sorter linked to a record that does not exist', () => {
    const bp = rich();
    bp.body.buildings[bp.body.buildings.length - 1].inputObjIdx = 500;
    expect(() => blueprintToLayout(bp, data)).toThrow(/inputObjIdx 500/);
  });

  test('a belt that outputs to itself', () => {
    const bp = rich();
    bp.body.buildings[5].outputObjIdx = 5;
    expect(() => blueprintToLayout(bp, data)).toThrow(/record 5.*itself/);
  });

  test('a skipped record with a wild link does not matter', () => {
    const bp = rich();
    bp.body.buildings[2].itemId = 9999;
    bp.body.buildings[2].outputObjIdx = 12345;
    expect(() => blueprintToLayout(bp, data)).not.toThrow();
  });

  test('a ring of belts imports as one belt that feeds itself', () => {
    const ring = layoutOf({ belts: [beltOf(1, [[0, 0], [1, 0], [1, 1], [0, 1]])] });
    const bp = roundTrip(ring).bp;
    bp.body.buildings[3].outputObjIdx = 0;
    const { layout } = blueprintToLayout(bp, data);
    expect(layout.belts).toHaveLength(1);
    expect(layout.belts[0].nodes).toHaveLength(4);
    expect(layout.belts[0].sink).toEqual({ kind: 'belt', beltId: layout.belts[0].id, node: 0 });
  });
});

// ---------------------------------------------------------------------------------------------

describe('regressionPlanFor', () => {
  const effects: TechEffects = kitEffects;
  const m0 = () => roundTrip(buildM0Layout(data)).layout;

  test('stages come from the recipes and machine counts; the target is the supply slot item', () => {
    const plan = regressionPlanFor(m0(), data, effects);
    expect(plan.stages).toHaveLength(1);
    const [stage] = plan.stages;
    expect(stage.recipeId).toBe(1);
    expect(stage.buildingItemId).toBe(2302);
    expect(stage.machines).toBe(3);
    expect(stage.exactMachines).toBe(3);
    expect(stage.utilization).toBe(1);
    // Iron ingot: 60 ticks, 1 ore for 1 ingot, on a 1x smelter: 1 craft/s each.
    expect(stage.perMachineCraftsPerSecond).toBeCloseTo(1, 9);
    expect(stage.craftsPerSecond).toBeCloseTo(3, 9);
    expect(stage.inputs).toEqual([{ itemId: 1001, perSecond: expect.closeTo(3, 9) }]);
    expect(stage.outputs).toEqual([{ itemId: 1101, perSecond: expect.closeTo(3, 9) }]);
    expect(plan.request.targetItemId).toBe(1101);
    expect(plan.exports).toEqual([{ itemId: 1101, perSecond: 0 }]);
  });

  test('the provisioned rate is 0, so nothing is judged against the plan', () => {
    const plan = regressionPlanFor(m0(), data, effects);
    expect(plan.request.quantity).toEqual({ kind: 'rate', perSecond: 0 });
    expect(plan.exports.find((e) => e.itemId === plan.request.targetItemId)?.perSecond).toBe(0);
    expect(plan.actualTargetRate).toBe(0);
    expect(plan.request.proliferator.tier).toBe(0);
    expect(plan.stationsNeeded).toBe(1);
    expect(plan.request.stationKind).toBe('interstellar');
    expect(plan.power.stationChargeW).toBeGreaterThan(0);
  });

  test('machines of one recipe on different buildings add their own capacities', () => {
    const layout = layoutOf({
      buildings: [
        ils({ station: station({ slots: [{ itemId: 1101, localLogic: 1, remoteLogic: 1, max: 100 }] }) }),
        smelter({ id: 2, x: 8 }),
        smelter({ id: 3, x: 12, itemId: 2315 }), // Plane Smelter, 2x
        { id: 4, itemId: 2303, x: 16, y: 0, z: 0, yaw: 0, recipeId: 2 },
        tower(5, 20, 0),
      ],
    });
    const plan = regressionPlanFor(layout, data, effects);
    expect(plan.stages.map((s) => [s.recipeId, s.machines])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    const speed = (itemId: number) => (data.building(itemId)?.production?.speed ?? 0) / 10000;
    expect(plan.stages[0].craftsPerSecond).toBeCloseTo(speed(2302) + speed(2315), 9);
    expect(plan.stages[0].buildingItemId).toBe(2302);
    expect(plan.stages[0].perMachineCraftsPerSecond).toBeCloseTo((speed(2302) + speed(2315)) / 2, 9);
  });

  test('with several supply slots the first is the target and the others are reported too', () => {
    const layout = layoutOf({
      buildings: [
        ils({
          station: station({
            slots: [
              { itemId: 1001, localLogic: 2, remoteLogic: 2, max: 100 },
              { itemId: 1102, localLogic: 1, remoteLogic: 1, max: 100 },
              { itemId: 1101, localLogic: 1, remoteLogic: 1, max: 100 },
            ],
          }),
        }),
      ],
    });
    const plan = regressionPlanFor(layout, data, effects);
    expect(plan.request.targetItemId).toBe(1102);
    expect(plan.exports.map((e) => e.itemId)).toEqual([1102, 1101]);
    expect(plan.request.suppliedItemIds).toEqual(new Set([1001]));
  });

  test('options name the target and extra items to report', () => {
    const plan = regressionPlanFor(m0(), data, effects, { targetItemId: 1001, alsoReport: [1101, 1001, 1002] });
    expect(plan.request.targetItemId).toBe(1001);
    expect(plan.exports.map((e) => e.itemId)).toEqual([1001, 1101, 1002]);
  });

  test('a layout without a supply slot needs an explicit target', () => {
    const layout = layoutOf({ buildings: [smelter()] });
    expect(() => regressionPlanFor(layout, data, effects)).toThrow(/supply/);
    expect(regressionPlanFor(layout, data, effects, { targetItemId: 1101 }).request.targetItemId).toBe(1101);
  });

  test('the imported M0 row simulates to the rate of the layout it came from', () => {
    const original = buildM0Layout(data);
    const imported = m0();
    const windows = { warmupTicks: 3600, measureTicks: 7200 };

    const plan: ProductionPlan = regressionPlanFor(imported, data, effects);
    const sim = runSimulation(imported, plan, data, effects, windows);

    const reference = regressionPlanFor(original, data, effects);
    const expected = runSimulation(original, reference, data, effects, windows);

    expect(expected.measuredTargetRate).toBeGreaterThan(2.9);
    expect(sim.measuredTargetRate).toBeCloseTo(expected.measuredTargetRate, 9);
    expect(sim.warnings).toEqual(expected.warnings);
    expect(sim.deadlocked).toBe(false);
  });

  test('the imported solver layout simulates to the same rate as the solver saw', async () => {
    const solved = await planFor({
      targetItemId: 1101,
      finalFacilityItemId: SMELTER,
      quantity: { kind: 'rate', perSecond: 3 },
      suppliedItemIds: new Set([1001]),
    });
    const result = solve(
      solved,
      kitData,
      kitEffects,
      { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1, seed: 7, simWarmupTicks: 1200, simMeasureTicks: 3600 },
      () => {},
      () => {},
      () => false,
    );
    const original = result.layout as Layout;
    expect(original, result.failures.join('; ')).not.toBeNull();
    const windows = { warmupTicks: 3600, measureTicks: 7200 };
    const expected = runSimulation(original, solved, kitData, kitEffects, windows);

    const { layout } = blueprintToLayout(decodeBlueprint(layoutToBlueprintString(original, kitData, OPTS)), kitData);
    const plan = regressionPlanFor(layout, kitData, kitEffects);
    expect(plan.stages.map((s) => s.machines)).toEqual(solved.stages.map((s) => s.machines));
    const sim = runSimulation(layout, plan, kitData, kitEffects, windows);
    expect(sim.measuredTargetRate).toBeCloseTo(expected.measuredTargetRate, 9);
    expect(sim.measuredTargetRate).toBeGreaterThan(2.9);
  }, 60_000);
});
