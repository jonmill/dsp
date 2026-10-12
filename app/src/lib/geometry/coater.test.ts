import { describe, expect, test } from 'vitest';
import { fixtureData } from '../validate/testkit';
import { coaterBuilding, coaterBuildings, coaterPlacementProblem, coaterProliferators, coaterTopPoint, findCoaterTop, sprayCoaterDef } from './coater';
import type { BeltPath, Layout, PlacedBuilding } from './model';
import { TILE } from './transform';

const def = sprayCoaterDef(fixtureData)!;
const PROLIFERATORS = coaterProliferators(def);

const belt = (id: number, nodes: [number, number, number?][], over: Partial<BeltPath> = {}): BeltPath => ({
  id,
  tierItemId: 2003,
  itemId: 1001,
  nodes: nodes.map(([x, y, z]) => ({ x, y, z: z ?? 0 })),
  plannedRate: 1,
  ...over,
});

const pose = (over: Partial<PlacedBuilding> = {}): PlacedBuilding => ({ id: 1, itemId: 2313, x: 3, y: 17, z: 0, yaw: 180, ...over });

const layoutOf = (over: Partial<Layout>): Layout => ({
  buildings: [],
  belts: [],
  sorters: [],
  meta: { geometrySource: 'approximate', gameVersion: 'test', planTargetItemId: 0, planTargetRate: 0 },
  ...over,
});

describe('coaterTopPoint', () => {
  // The capsule sample (docs/research/blueprint-samples): the coater at (3, 17, 0) turned 180 has its proliferator belt at
  // (3, 18, 1.006); belt flows from y 19 to y 15, so the top passage is the node one step upstream.
  const BACK = 1.25 / TILE;

  test.each([
    { yaw: 180 as const, at: [3, 17 + BACK] },
    { yaw: 0 as const, at: [3, 17 - BACK] },
    { yaw: 90 as const, at: [3 - BACK, 17] },
    { yaw: 270 as const, at: [3 + BACK, 17] },
  ])('turned $yaw it is 1.25 m upstream along the axis and one level up', ({ yaw, at }) => {
    const p = coaterTopPoint(pose({ yaw }));
    expect([p.x, p.y]).toEqual([expect.closeTo(at[0], 9), expect.closeTo(at[1], 9)]);
    expect(p.z).toBeCloseTo(1, 9);
  });

  test('it is within a hundredth of a tile of the lattice node the sample puts the proliferator belt on', () => {
    const p = coaterTopPoint(pose());
    expect(Math.hypot(p.x - 3, p.y - 18)).toBeLessThan(0.01);
  });

  test('it is upstream of the node the coater stands on, for a belt flowing in any direction', () => {
    // a coater turned `yaw` faces the way its belt flows; the point is behind it
    const flow = { 0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0] } as const;
    for (const yaw of [0, 90, 180, 270] as const) {
      const p = coaterTopPoint(pose({ yaw, x: 0, y: 0 }));
      const [fx, fy] = flow[yaw];
      expect(p.x * fx + p.y * fy).toBeLessThan(-0.9);
    }
  });
});

describe('coaterBuilding and coaterBuildings', () => {
  const run = belt(7, [[3, 19], [3, 18], [3, 17], [3, 16], [3, 15]]);

  test('a coater stands where its belt node is, with its own id and yaw', () => {
    expect(coaterBuilding({ id: 900, beltId: 7, node: 2, yaw: 180 }, run, def)).toEqual({
      id: 900,
      itemId: 2313,
      x: 3,
      y: 17,
      z: 0,
      yaw: 180,
      role: 'coater',
    });
  });

  test('no belt or no such node: no building', () => {
    expect(coaterBuilding({ id: 900, beltId: 7, node: 9, yaw: 180 }, run, def)).toBeUndefined();
    expect(coaterBuilding({ id: 900, beltId: 7, node: 2, yaw: 180 }, undefined, def)).toBeUndefined();
  });

  test('a layout without coaters, or with only dangling ones, has none', () => {
    expect(coaterBuildings(layoutOf({ belts: [run] }), fixtureData)).toEqual([]);
    expect(coaterBuildings(layoutOf({ belts: [run], coaters: [{ id: 1, beltId: 8, node: 2, yaw: 180 }] }), fixtureData)).toEqual([]);
    expect(coaterBuildings(layoutOf({ belts: [run], coaters: [{ id: 1, beltId: 7, node: 2, yaw: 180 }] }), fixtureData)).toHaveLength(1);
  });
});

describe('coaterPlacementProblem', () => {
  const straight = belt(1, [[3, 19], [3, 18], [3, 17], [3, 16], [3, 15]]);

  test('the middle of a straight ground run, turned the way the belt flows, is fine', () => {
    for (const node of [1, 2, 3]) expect(coaterPlacementProblem(straight, node, 180)).toBeUndefined();
  });

  test('every direction of flow', () => {
    expect(coaterPlacementProblem(belt(1, [[0, 0], [1, 0], [2, 0]]), 1, 90)).toBeUndefined();
    expect(coaterPlacementProblem(belt(1, [[2, 0], [1, 0], [0, 0]]), 1, 270)).toBeUndefined();
    expect(coaterPlacementProblem(belt(1, [[0, 0], [0, 1], [0, 2]]), 1, 0)).toBeUndefined();
  });

  test('the first and the last node of a belt have no neighbour on one side', () => {
    expect(coaterPlacementProblem(straight, 0, 180)).toMatch(/first node/);
    expect(coaterPlacementProblem(straight, 4, 180)).toMatch(/last node/);
    expect(coaterPlacementProblem(straight, 9, 180)).toMatch(/no node 9/);
  });

  test('a corner, and the nodes beside it, are not a straight run', () => {
    const bent = belt(1, [[3, 19], [3, 18], [3, 17], [4, 17], [5, 17]]);
    expect(coaterPlacementProblem(bent, 2, 180)).toMatch(/not a straight run/);
    // node 1 has a straight neighbour on each side; so has node 3, on the new leg, which flows east
    expect(coaterPlacementProblem(bent, 1, 180)).toBeUndefined();
    expect(coaterPlacementProblem(bent, 3, 90)).toBeUndefined();
    expect(coaterPlacementProblem(bent, 3, 180)).toMatch(/runs along 90 degrees .* turned 180/);
  });

  test('a node above the ground, or next to a lift, is not on the ground', () => {
    const lifted = belt(1, [[0, 0], [1, 0], [2, 0], [2, 0, 1], [3, 0, 1], [4, 0, 1]]);
    expect(coaterPlacementProblem(lifted, 1, 90)).toBeUndefined();
    expect(coaterPlacementProblem(lifted, 2, 90)).toMatch(/not all on the ground/);
    expect(coaterPlacementProblem(lifted, 4, 90)).toMatch(/not all on the ground/);
    const high = belt(1, [[0, 0, 1], [1, 0, 1], [2, 0, 1]]);
    expect(coaterPlacementProblem(high, 1, 90)).toMatch(/not all on the ground/);
  });

  test('a coater is turned along its belt, with the flow or against it (the capsule sample has both)', () => {
    expect(coaterPlacementProblem(straight, 2, 180)).toBeUndefined();
    expect(coaterPlacementProblem(straight, 2, 0)).toBeUndefined();
  });

  test('a coater turned across its belt is wrong', () => {
    for (const yaw of [90, 270] as const) {
      expect(coaterPlacementProblem(straight, 2, yaw)).toMatch(new RegExp(`runs along 180 degrees .* turned ${yaw}: it must be turned along its belt`));
    }
  });

  test('a game export is a little off the lattice and still counts', () => {
    // the capsule sample: the coater at (7, 17), its upstream node at (7, 17.954)
    const export_ = belt(1, [[7, 18.9079, 0.0108], [7, 17.954, 0.0027], [7, 17, 0], [7, 16, 0], [7, 15, 0]]);
    expect(coaterPlacementProblem(export_, 2, 180)).toBeUndefined();
    expect(coaterPlacementProblem(export_, 1, 180)).toBeUndefined();
  });

  test('nodes that are not a node apart are not a run of single steps', () => {
    expect(coaterPlacementProblem(belt(1, [[0, 0], [1, 0], [3, 0]]), 1, 90)).toMatch(/not a straight run of single steps/);
    expect(coaterPlacementProblem(belt(1, [[0, 0], [0.3, 0], [1, 0]]), 1, 90)).toMatch(/not a straight run of single steps/);
  });
});

describe('findCoaterTop', () => {
  const item = belt(1, [[3, 19], [3, 18], [3, 17], [3, 16], [3, 15]]);
  const spray = (nodes: [number, number, number?][], over: Partial<BeltPath> = {}) => belt(2, nodes, { itemId: 1143, tierItemId: 2001, ...over });
  const crossing: [number, number, number][] = [[5, 18, 1], [4, 18, 1], [3, 18, 1], [2, 18, 1], [1, 18, 1]];

  test('finds the proliferator belt node one step upstream and one level up', () => {
    const l = layoutOf({ belts: [item, spray(crossing)] });
    const hit = findCoaterTop(l, pose(), PROLIFERATORS);
    expect(hit?.belt.id).toBe(2);
    expect(hit?.node).toBe(2);
  });

  test('a node on the other side of the coater, or at the wrong height, is not the top passage', () => {
    const downstream: [number, number, number][] = [[5, 16, 1], [4, 16, 1], [3, 16, 1], [2, 16, 1]];
    expect(findCoaterTop(layoutOf({ belts: [item, spray(downstream)] }), pose(), PROLIFERATORS)).toBeNull();
    const low: [number, number, number][] = [[4, 18, 0], [3, 18, 0], [2, 18, 0]];
    expect(findCoaterTop(layoutOf({ belts: [item, spray(low)] }), pose(), PROLIFERATORS)).toBeNull();
    const high: [number, number, number][] = [[4, 18, 2], [3, 18, 2], [2, 18, 2]];
    expect(findCoaterTop(layoutOf({ belts: [item, spray(high)] }), pose(), PROLIFERATORS)).toBeNull();
  });

  test('a belt that carries something else is not a proliferator belt; one of no known item might be', () => {
    expect(findCoaterTop(layoutOf({ belts: [item, spray(crossing, { itemId: 1001 })] }), pose(), PROLIFERATORS)).toBeNull();
    expect(findCoaterTop(layoutOf({ belts: [item, spray(crossing, { itemId: 0 })] }), pose(), PROLIFERATORS)?.belt.id).toBe(2);
    for (const itemId of [1141, 1142, 1143]) {
      expect(findCoaterTop(layoutOf({ belts: [item, spray(crossing, { itemId })] }), pose(), PROLIFERATORS)?.belt.id).toBe(2);
    }
  });

  test('a node a game export put a hair off the lattice is found', () => {
    const wander: [number, number, number][] = [[4, 18, 1.0058], [3, 18.004, 1.0058], [2, 18, 1.0058]];
    expect(findCoaterTop(layoutOf({ belts: [item, spray(wander)] }), pose(), PROLIFERATORS)?.node).toBe(1);
  });
});
