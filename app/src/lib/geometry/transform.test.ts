import { describe, expect, test } from 'vitest';
import type { Yaw } from './model';
import { beltNodeYaws, headingDeg, LEVEL, prefabDirToGrid, prefabToGrid, rotateYaw, TILE } from './transform';

describe('constants', () => {
  test('a tile is 2π·200/1000 m and a level 4/3 m', () => {
    expect(TILE).toBe((2 * Math.PI * 200) / 1000);
    expect(LEVEL).toBe(4 / 3);
  });
});

describe('rotateYaw', () => {
  test('north rotates clockwise to east at yaw 90', () => {
    expect(rotateYaw(0, 1, 90)).toEqual([1, 0]);
  });

  test('north goes east, south, west for yaw 90, 180, 270; east goes south at yaw 90', () => {
    expect(rotateYaw(0, 1, 0)).toEqual([0, 1]);
    expect(rotateYaw(0, 1, 180)).toEqual([0, -1]);
    expect(rotateYaw(0, 1, 270)).toEqual([-1, 0]);
    expect(rotateYaw(1, 0, 90)).toEqual([0, -1]);
    expect(rotateYaw(1, 0, 180)).toEqual([-1, 0]);
    expect(rotateYaw(1, 0, 270)).toEqual([0, 1]);
  });

  test('is exact (no sin/cos noise) and returns +0, never -0', () => {
    for (const yaw of [0, 90, 180, 270] as Yaw[]) {
      for (const v of rotateYaw(0, 3, yaw)) expect(Object.is(v, -0)).toBe(false);
    }
    expect(rotateYaw(2, 3, 90)).toEqual([3, -2]);
  });

  test('rejects a yaw that is not a quarter turn', () => {
    expect(() => rotateYaw(0, 1, 45 as Yaw)).toThrow(/yaw 45/);
  });
});

describe('prefabToGrid', () => {
  const at = (yaw: Yaw) => ({ x: 10, y: 20, z: 3, yaw });

  test('building at (10,20,0) yaw 90 maps p = (0,0,TILE) to (11,20,0)', () => {
    expect(prefabToGrid({ x: 10, y: 20, z: 0, yaw: 90 }, [0, 0, TILE])).toEqual({ x: 11, y: 20, z: 0 });
  });

  test('rotates prefab metres clockwise from north and scales to tiles and levels', () => {
    // +pz is forward = north at yaw 0, east at yaw 90, south at yaw 180, west at yaw 270.
    const p: [number, number, number] = [0, 0, TILE];
    expect(prefabToGrid(at(0), p)).toEqual({ x: 10, y: 21, z: 3 });
    expect(prefabToGrid(at(90), p)).toEqual({ x: 11, y: 20, z: 3 });
    expect(prefabToGrid(at(180), p)).toEqual({ x: 10, y: 19, z: 3 });
    expect(prefabToGrid(at(270), p)).toEqual({ x: 9, y: 20, z: 3 });
  });

  test('+px is right: east at yaw 0, south at yaw 90; py is up in levels', () => {
    const p: [number, number, number] = [TILE, 4 / 3, 0];
    expect(prefabToGrid(at(0), p)).toEqual({ x: 11, y: 20, z: 4 });
    expect(prefabToGrid(at(90), p)).toEqual({ x: 10, y: 19, z: 4 });
  });

  test('rejects an unsupported yaw', () => {
    expect(() => prefabToGrid({ x: 0, y: 0, z: 0, yaw: 45 as Yaw }, [0, 0, 1])).toThrow(/yaw 45/);
  });
});

describe('prefabDirToGrid', () => {
  const identity: [number, number, number, number] = [0, 0, 0, 1];
  const quarterLeft: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2]; // +90° about up
  const quarterRight: [number, number, number, number] = [0, Math.SQRT1_2, 0, -Math.SQRT1_2]; // -90° about up

  test('forward (+pz) is north at yaw 0 and turns clockwise with the building', () => {
    expect(prefabDirToGrid(0, identity)).toEqual([0, 1]);
    expect(prefabDirToGrid(90, identity)).toEqual([1, 0]);
    expect(prefabDirToGrid(180, identity)).toEqual([0, -1]);
    expect(prefabDirToGrid(270, identity)).toEqual([-1, 0]);
  });

  test('a slot pose turned +90° about up faces east at yaw 0 (the assembler east face), south at yaw 90', () => {
    const [e0, n0] = prefabDirToGrid(0, quarterLeft);
    expect(e0).toBeCloseTo(1, 12);
    expect(n0).toBeCloseTo(0, 12);
    const [e90, n90] = prefabDirToGrid(90, quarterLeft);
    expect(e90).toBeCloseTo(0, 12);
    expect(n90).toBeCloseTo(-1, 12);
  });

  test('a pose turned -90° faces west at yaw 0', () => {
    const [e, n] = prefabDirToGrid(0, quarterRight);
    expect(e).toBeCloseTo(-1, 12);
    expect(n).toBeCloseTo(0, 12);
  });

  test('is a unit vector for a turn of any angle', () => {
    const half = (30 * Math.PI) / 180 / 2;
    const [e, n] = prefabDirToGrid(0, [0, Math.sin(half), 0, Math.cos(half)]);
    expect(e).toBeCloseTo(Math.sin((30 * Math.PI) / 180), 12);
    expect(n).toBeCloseTo(Math.cos((30 * Math.PI) / 180), 12);
    expect(Math.hypot(e, n)).toBeCloseTo(1, 12);
  });

  test('rejects a pose that faces straight up', () => {
    const up: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    expect(() => prefabDirToGrid(0, up)).toThrow(/vertical/);
  });
});

describe('headingDeg', () => {
  test('degrees clockwise from north, in [0, 360)', () => {
    expect(headingDeg(0, 1)).toBe(0);
    expect(headingDeg(1, 0)).toBe(90);
    expect(headingDeg(0, -1)).toBe(180);
    expect(headingDeg(-1, 0)).toBe(270);
    expect(headingDeg(1, 1)).toBe(45);
    expect(headingDeg(-1, -1)).toBe(225);
  });
});

describe('beltNodeYaws', () => {
  const pts = (...xyz: [number, number, number?][]) => xyz.map(([x, y, z]) => ({ x, y, z: z ?? 0 }));

  test('a straight run keeps its heading, the last node keeps the one before', () => {
    expect(beltNodeYaws(pts([0, 0], [1, 0], [2, 0], [3, 0]))).toEqual([90, 90, 90, 90]);
    expect(beltNodeYaws(pts([0, 0], [0, -1], [0, -2]))).toEqual([180, 180, 180]);
  });

  test('a corner takes the bisector of the incoming and outgoing headings', () => {
    // East then south: 90° in, 180° out, bisector 135° (capsule sample #101 at (15,22)).
    expect(beltNodeYaws(pts([14, 22], [15, 22], [15, 21]))).toEqual([90, 135, 180]);
    // South then east: 180° in, 90° out.
    expect(beltNodeYaws(pts([14, 22], [14, 21], [15, 21]))).toEqual([180, 135, 90]);
    // North then west: 0° in, 270° out, bisector 315° (across north, not through south).
    expect(beltNodeYaws(pts([0, 0], [0, 1], [-1, 1]))).toEqual([0, 315, 270]);
    // West then north: 270° in, 0° out.
    expect(beltNodeYaws(pts([2, 1], [1, 1], [1, 2]))).toEqual([270, 315, 0]);
    // South then west: 180° in, 270° out.
    expect(beltNodeYaws(pts([0, 2], [0, 1], [-1, 1]))).toEqual([180, 225, 270]);
    // East then north: 90° in, 0° out.
    expect(beltNodeYaws(pts([0, 0], [1, 0], [1, 1]))).toEqual([90, 45, 0]);
  });

  test('an S-bend corners twice and a straight node in between is untouched', () => {
    const yaws = beltNodeYaws(pts([0, 0], [1, 0], [1, 1], [1, 2], [2, 2], [3, 2]));
    expect(yaws).toEqual([90, 45, 0, 45, 90, 90]);
  });

  test('a vertical lift keeps the heading it arrived with, and the node after takes the next heading', () => {
    const yaws = beltNodeYaws(pts([0, 0, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1], [2, 1, 1]));
    expect(yaws).toEqual([0, 0, 90, 90, 90]);
  });

  test('a belt that starts with a lift takes the first real heading', () => {
    expect(beltNodeYaws(pts([0, 0, 0], [0, 0, 1], [1, 0, 1]))).toEqual([90, 90, 90]);
  });

  test('a single node, an empty belt and a belt that never moves sideways', () => {
    expect(beltNodeYaws(pts([5, 5]))).toEqual([0]);
    expect(beltNodeYaws([])).toEqual([]);
    expect(beltNodeYaws(pts([0, 0, 0], [0, 0, 1]))).toEqual([0, 0]);
  });
});
