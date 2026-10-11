import { describe, expect, test } from 'vitest';
import { GameDataIndex } from '../data';
import type { Building, Collider } from '../data';
import { loadFixtureGameData } from '../../../test/fixtures/fixtureGameData';
import { buildingOBBs } from './footprint';
import type { PlacedBuilding, Yaw } from './model';
import { obbOverlap, pointInOBBs } from './obb';
import { LEVEL, TILE } from './transform';

const data = new GameDataIndex(loadFixtureGameData());
const def = (itemId: number): Building => {
  const b = data.building(itemId);
  if (!b) throw new Error(`no building ${itemId}`);
  return b;
};

const placed = (itemId: number, x: number, y: number, yaw: Yaw = 0, z = 0): PlacedBuilding => ({ id: 1, itemId, x, y, z, yaw });
const ASSEMBLER = 2303;
const SMELTER = 2302;
const ILS = 2104;

const overlaps = (a: PlacedBuilding, b: PlacedBuilding): boolean =>
  buildingOBBs(a, def(a.itemId)).some((p) => buildingOBBs(b, def(b.itemId)).some((q) => obbOverlap(p, q)));

describe('buildingOBBs', () => {
  test('an assembler is one 4 m square box on the ground, 4.6 m tall', () => {
    const [obb, ...rest] = buildingOBBs(placed(ASSEMBLER, 3, 5), def(ASSEMBLER));
    expect(rest).toHaveLength(0);
    expect(obb.cx).toBeCloseTo(3, 12);
    expect(obb.cy).toBeCloseTo(5, 12);
    expect(obb.hx).toBeCloseTo(2 / TILE, 12);
    expect(obb.hy).toBeCloseTo(2 / TILE, 12);
    expect(obb.zMin).toBeCloseTo(0, 12);
    expect(obb.zMax).toBeCloseTo(4.6 / LEVEL, 12);
  });

  test('z follows the building height in levels', () => {
    const [obb] = buildingOBBs(placed(ASSEMBLER, 0, 0, 0, 2), def(ASSEMBLER));
    expect(obb.zMin).toBeCloseTo(2, 12);
    expect(obb.zMax).toBeCloseTo(2 + 4.6 / LEVEL, 12);
  });

  test('the station is two crossed boxes (4×2 m and 2×4 m half extents)', () => {
    const obbs = buildingOBBs(placed(ILS, 0, 0), def(ILS));
    expect(obbs).toHaveLength(2);
    // The arm along the east-west axis reaches 4 m east but only 2 m north.
    expect(pointInOBBs(3.1, 1, null, obbs, 0)).toBe(true);
    expect(pointInOBBs(3.1, 1.7, null, obbs, 0)).toBe(false);
    expect(pointInOBBs(1, 3.1, null, obbs, 0)).toBe(true);
    expect(pointInOBBs(1.7, 3.1, null, obbs, 0)).toBe(false);
    // The corner of the 4×4 m bounding square is empty.
    expect(pointInOBBs(2, 2, null, obbs, 0)).toBe(false);
  });

  test('yaw 90 turns the station arms: the long arm that ran east now runs south', () => {
    // Fixture station is symmetric, so use a lopsided synthetic building.
    const lopsided: Building = {
      ...def(ASSEMBLER),
      geometry: {
        ...def(ASSEMBLER).geometry,
        colliders: [{ center: [0, 1, 0], halfExtents: [4, 1, 1], rotation: [0, 0, 0, 1], usage: 'build' }],
      },
    };
    const at0 = buildingOBBs(placed(ASSEMBLER, 0, 0, 0), lopsided);
    expect(pointInOBBs(3, 0, null, at0, 0)).toBe(true);
    expect(pointInOBBs(0, 3, null, at0, 0)).toBe(false);
    const at90 = buildingOBBs(placed(ASSEMBLER, 0, 0, 90), lopsided);
    expect(pointInOBBs(3, 0, null, at90, 0)).toBe(false);
    expect(pointInOBBs(0, -3, null, at90, 0)).toBe(true);
    expect(pointInOBBs(0, 3, null, at90, 0)).toBe(true);
  });

  test('an offset collider moves with the building yaw', () => {
    const offset: Building = {
      ...def(ASSEMBLER),
      geometry: {
        ...def(ASSEMBLER).geometry,
        // A 1 m box 3 m to the right of the origin (+px = east at yaw 0).
        colliders: [{ center: [3, 0.5, 0], halfExtents: [0.5, 0.5, 0.5], rotation: [0, 0, 0, 1], usage: 'build' }],
      },
    };
    const [a] = buildingOBBs(placed(ASSEMBLER, 0, 0, 0), offset);
    expect([a.cx, a.cy]).toEqual([3 / TILE, 0]);
    const [b] = buildingOBBs(placed(ASSEMBLER, 0, 0, 90), offset);
    expect(b.cx).toBeCloseTo(0, 12);
    expect(b.cy).toBeCloseTo(-3 / TILE, 12);
  });

  test('a collider turned 45° about up is a diamond in plan view', () => {
    const half = Math.PI / 8; // quaternion half-angle for 45°
    const turned: Collider = {
      center: [0, 1, 0],
      halfExtents: [1, 1, 0.5],
      rotation: [0, Math.sin(half), 0, Math.cos(half)],
      usage: 'build',
    };
    const bd: Building = { ...def(ASSEMBLER), geometry: { ...def(ASSEMBLER).geometry, colliders: [turned] } };
    const obbs = buildingOBBs(placed(ASSEMBLER, 0, 0), bd);
    expect(obbs).toHaveLength(1);
    expect(obbs[0].hx).toBeCloseTo(1 / TILE, 12);
    expect(obbs[0].hy).toBeCloseTo(0.5 / TILE, 12);
    // Local x runs (cos 45°, -sin 45°) in (east, north) at yaw 0; the long axis points south-east.
    const m = 0.9 / TILE;
    expect(pointInOBBs(m * Math.SQRT1_2, -m * Math.SQRT1_2, null, obbs, 0)).toBe(true);
    expect(pointInOBBs(m * Math.SQRT1_2, m * Math.SQRT1_2, null, obbs, 0)).toBe(false);
  });

  test('only build colliders count, and with none the others are used', () => {
    const box = (usage: Collider['usage'], hx: number): Collider => ({
      center: [0, 1, 0],
      halfExtents: [hx, 1, hx],
      rotation: [0, 0, 0, 1],
      usage,
    });
    const withBuild: Building = {
      ...def(ASSEMBLER),
      geometry: { ...def(ASSEMBLER).geometry, colliders: [box('physics', 3), box('build', 1), box('other', 2)] },
    };
    const only = buildingOBBs(placed(ASSEMBLER, 0, 0), withBuild);
    expect(only).toHaveLength(1);
    expect(only[0].hx).toBeCloseTo(1 / TILE, 12);

    const noBuild: Building = {
      ...def(ASSEMBLER),
      geometry: { ...def(ASSEMBLER).geometry, colliders: [box('physics', 3), box('other', 2)] },
    };
    expect(buildingOBBs(placed(ASSEMBLER, 0, 0), noBuild).map((o) => o.hx)).toEqual([3 / TILE, 2 / TILE]);
  });

  test('a building with no colliders has no footprint', () => {
    const none: Building = { ...def(ASSEMBLER), geometry: { ...def(ASSEMBLER).geometry, colliders: [] } };
    expect(buildingOBBs(placed(ASSEMBLER, 0, 0), none)).toEqual([]);
  });

  test('a tilted collider is bounded by its projection on the ground', () => {
    // 45° about the east axis: a 1×1×1 m half-extent box tilts so its footprint grows along north.
    const half = Math.PI / 8;
    const tilted: Collider = { center: [0, 1, 0], halfExtents: [1, 1, 1], rotation: [Math.sin(half), 0, 0, Math.cos(half)], usage: 'build' };
    const bd: Building = { ...def(ASSEMBLER), geometry: { ...def(ASSEMBLER).geometry, colliders: [tilted] } };
    const [obb] = buildingOBBs(placed(ASSEMBLER, 0, 0), bd);
    expect(obb.hx).toBeCloseTo(1 / TILE, 12);
    expect(obb.hy).toBeCloseTo(Math.SQRT2 / TILE, 12);
    expect((obb.zMax - obb.zMin) / 2).toBeCloseTo(Math.SQRT2 / LEVEL, 12);
  });
});

describe('fixture buildings against each other', () => {
  test('assemblers 4 tiles apart do not overlap, 3 tiles apart do (3 tiles = 3.77 m < 4 m)', () => {
    expect(overlaps(placed(ASSEMBLER, 0, 0), placed(ASSEMBLER, 4, 0))).toBe(false);
    expect(overlaps(placed(ASSEMBLER, 0, 0), placed(ASSEMBLER, 3, 0))).toBe(true);
    expect(overlaps(placed(ASSEMBLER, 0, 0), placed(ASSEMBLER, 0, 3))).toBe(true);
    expect(overlaps(placed(ASSEMBLER, 0, 0), placed(ASSEMBLER, 0, -4))).toBe(false);
  });

  test('assemblers at the same tile but different heights stack without overlapping above the roof', () => {
    // Roof at 4.6 m = 3.45 levels, so a second assembler on level 4 clears it and one on level 3 does not.
    expect(overlaps(placed(ASSEMBLER, 0, 0, 0, 0), placed(ASSEMBLER, 0, 0, 0, 4))).toBe(false);
    expect(overlaps(placed(ASSEMBLER, 0, 0, 0, 0), placed(ASSEMBLER, 0, 0, 0, 3))).toBe(true);
  });

  test('smelters (3 m) fit on a 3 tile pitch, are cramped on 2', () => {
    expect(overlaps(placed(SMELTER, 0, 0), placed(SMELTER, 3, 0))).toBe(false);
    expect(overlaps(placed(SMELTER, 0, 0), placed(SMELTER, 2, 0))).toBe(true);
  });

  test('yaw does not change a square footprint', () => {
    for (const yaw of [0, 90, 180, 270] as Yaw[]) {
      expect(overlaps(placed(ASSEMBLER, 0, 0, yaw), placed(ASSEMBLER, 4, 0, 90))).toBe(false);
      expect(overlaps(placed(ASSEMBLER, 0, 0, yaw), placed(ASSEMBLER, 3, 0, 90))).toBe(true);
    }
  });

  test('an assembler tucks into the cross-shaped station corner but not its arm', () => {
    // The station's arm along north reaches 4 m = 3.18 tiles at 2 m = 1.59 tiles wide; the corner (2 m, 2 m) is empty.
    expect(overlaps(placed(ILS, 0, 0), placed(ASSEMBLER, 3.5, 3.5))).toBe(false);
    expect(overlaps(placed(ILS, 0, 0), placed(ASSEMBLER, 0, 5))).toBe(false);
    expect(overlaps(placed(ILS, 0, 0), placed(ASSEMBLER, 0, 3.5))).toBe(true);
    expect(overlaps(placed(ILS, 0, 0), placed(ASSEMBLER, 3.5, 0))).toBe(true);
  });
});
