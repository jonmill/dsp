import { describe, expect, test } from 'vitest';
import { obbOverlap, pointInOBBs } from './obb';
import type { OBB2 } from './obb';

const square = (cx: number, cy: number, half = 0.5, angle = 0, zMin = 0, zMax = 1): OBB2 => ({
  cx,
  cy,
  hx: half,
  hy: half,
  angle,
  zMin,
  zMax,
});

const R = Math.SQRT1_2;

describe('obbOverlap', () => {
  test('1×1 squares 1.5 apart do not overlap, 0.9 apart do', () => {
    expect(obbOverlap(square(0, 0), square(1.5, 0))).toBe(false);
    expect(obbOverlap(square(0, 0), square(0.9, 0))).toBe(true);
    expect(obbOverlap(square(0, 0), square(0, 1.5))).toBe(false);
    expect(obbOverlap(square(0, 0), square(0, -0.9))).toBe(true);
  });

  test('is symmetric', () => {
    const a = square(0, 0, 0.5, 0.3);
    const b = square(0.8, 0.4, 0.5, -0.2);
    expect(obbOverlap(a, b)).toBe(obbOverlap(b, a));
    expect(obbOverlap(a, b)).toBe(true);
  });

  test('touching faces and touching corners are not overlaps', () => {
    expect(obbOverlap(square(0, 0), square(1, 0))).toBe(false);
    expect(obbOverlap(square(0, 0), square(1, 1))).toBe(false);
    // Penetration under eps (0.02 tiles by default) is a touch, not an overlap.
    expect(obbOverlap(square(0, 0), square(0.99, 0))).toBe(false);
    expect(obbOverlap(square(0, 0), square(0.99, 0), 0)).toBe(true);
    expect(obbOverlap(square(0, 0), square(0.9, 0), 0.2)).toBe(false);
  });

  test('a square turned 45° touches an upright one at its corner', () => {
    // The diamond's west corner is √2/2 from its centre.
    const touching = square(0.5 + R, 0, 0.5, Math.PI / 4);
    expect(obbOverlap(square(0, 0), touching)).toBe(false);
    expect(obbOverlap(square(0, 0), square(0.5 + R - 0.1, 0, 0.5, Math.PI / 4))).toBe(true);
    expect(obbOverlap(square(0, 0), square(0.5 + R + 0.1, 0, 0.5, Math.PI / 4))).toBe(false);
    // Diagonal neighbour of the diamond: its edge passes the upright square's corner without touching.
    expect(obbOverlap(square(0, 0), square(0.9, 0.9, 0.5, Math.PI / 4))).toBe(false);
    expect(obbOverlap(square(0, 0), square(0.6, 0.6, 0.5, Math.PI / 4))).toBe(true);
  });

  test('two squares turned the same 45° touch along an edge', () => {
    const a = square(0, 0, 0.5, Math.PI / 4);
    // Their edges face along (1,1)/√2: centres one side-length apart along that direction.
    expect(obbOverlap(a, square(R, R, 0.5, Math.PI / 4))).toBe(false);
    expect(obbOverlap(a, square(R * 0.8, R * 0.8, 0.5, Math.PI / 4))).toBe(true);
  });

  test('rectangles use hx along the angle and hy across it', () => {
    const bar: OBB2 = { cx: 0, cy: 0, hx: 2, hy: 0.25, angle: Math.PI / 2, zMin: 0, zMax: 1 };
    // Turned 90°, the long side runs north to south.
    expect(obbOverlap(bar, square(0, 1.8))).toBe(true);
    expect(obbOverlap(bar, square(1.4, 0))).toBe(false);
    expect(obbOverlap(bar, square(1.4, 1.8))).toBe(false);
  });

  test('disjoint z intervals never overlap, whatever the plan view says', () => {
    expect(obbOverlap(square(0, 0, 0.5, 0, 0, 2), square(0, 0, 0.5, 0, 2, 4))).toBe(false);
    expect(obbOverlap(square(0, 0, 0.5, 0, 0, 2), square(0, 0, 0.5, 0, 3, 4))).toBe(false);
    expect(obbOverlap(square(0, 0, 0.5, 0, 3, 4), square(0, 0, 0.5, 0, 0, 2))).toBe(false);
    expect(obbOverlap(square(0, 0, 0.5, 0, 0, 2), square(0, 0, 0.5, 0, 1, 3))).toBe(true);
    // One box inside the other's height range.
    expect(obbOverlap(square(0, 0, 0.5, 0, 0, 10), square(0, 0, 0.5, 0, 4, 5))).toBe(true);
  });

  test('a box thinner than eps shrinks to a line and does not go negative', () => {
    expect(obbOverlap(square(0.5, 0, 0.01), square(0, 0, 0.5))).toBe(false);
    expect(obbOverlap(square(0.2, 0, 0.01), square(0, 0, 0.5))).toBe(true);
  });
});

describe('pointInOBBs', () => {
  const box = square(0, 0, 1, 0, 0, 2);

  test('inside, outside, and the boundary counts as outside', () => {
    expect(pointInOBBs(0.5, 0.5, 1, [box], 0)).toBe(true);
    expect(pointInOBBs(1.5, 0, 1, [box], 0)).toBe(false);
    expect(pointInOBBs(1, 0, 1, [box], 0)).toBe(false);
    expect(pointInOBBs(0.999, 0, 1, [box], 0)).toBe(true);
  });

  test('inflate grows the box in plan view', () => {
    expect(pointInOBBs(1.2, 0, 1, [box], 0.25)).toBe(true);
    expect(pointInOBBs(1.3, 0, 1, [box], 0.25)).toBe(false);
    expect(pointInOBBs(1.2, 1.2, 1, [box], 0.25)).toBe(true);
  });

  test('height is half open: the base counts, the top does not', () => {
    expect(pointInOBBs(0, 0, 0, [box], 0)).toBe(true);
    expect(pointInOBBs(0, 0, 1.99, [box], 0)).toBe(true);
    expect(pointInOBBs(0, 0, 2, [box], 0)).toBe(false);
    expect(pointInOBBs(0, 0, -0.5, [box], 0)).toBe(false);
  });

  test('a null height skips the height test (footprints)', () => {
    expect(pointInOBBs(0, 0, null, [box], 0)).toBe(true);
    expect(pointInOBBs(5, 0, null, [box], 0)).toBe(false);
  });

  test('a turned box is tested in its own frame', () => {
    const diamond = square(0, 0, 1, Math.PI / 4, 0, 2);
    // The diamond's corners point along the world axes (to 1.414 from the centre), its faces along the diagonals.
    expect(pointInOBBs(0.6, 0.6, 1, [diamond], 0)).toBe(true);
    expect(pointInOBBs(1.2, 0, 1, [diamond], 0)).toBe(true);
    expect(pointInOBBs(1.2, 0, 1, [box], 0)).toBe(false);
    expect(pointInOBBs(0.95, 0.95, 1, [diamond], 0)).toBe(false);
    expect(pointInOBBs(0.95, 0.95, 1, [box], 0)).toBe(true);
  });

  test('any box of several containing the point is enough; none gives false', () => {
    expect(pointInOBBs(3, 0, 1, [box, square(3, 0, 0.5, 0, 0, 2)], 0)).toBe(true);
    expect(pointInOBBs(3, 3, 1, [box, square(3, 0, 0.5, 0, 0, 2)], 0)).toBe(false);
    expect(pointInOBBs(0, 0, 1, [], 0)).toBe(false);
  });
});
