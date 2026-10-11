// 2D oriented boxes with a height interval, for collision between placed buildings and belts.

/**
 * An oriented box in grid space. `angle` is the direction of the `hx` axis, in radians counter-clockwise from
 * east (the usual math orientation); `hy` runs 90° to the left of it. `cx`, `cy`, `hx`, `hy` are in tiles;
 * `zMin`..`zMax` is the height interval in levels.
 */
export interface OBB2 {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  angle: number;
  zMin: number;
  zMax: number;
}

/** Penetrations up to twice this (tiles, or levels) count as touching. */
export const DEFAULT_OVERLAP_EPS = 0.02;

/** Slack that makes a point exactly on a face count as outside, whatever the float noise. */
const FACE_SLACK = 1e-9;

/**
 * Do two boxes overlap? Separating axis test in plan view plus an overlap of the height intervals. Every
 * half extent and half height is shrunk by `eps` first (not below zero), so touching boxes and slivers of
 * contact thinner than `2·eps` do not count. Touching is never an overlap.
 */
export function obbOverlap(a: OBB2, b: OBB2, eps: number = DEFAULT_OVERLAP_EPS): boolean {
  if (!intervalsOverlap(a.zMin, a.zMax, b.zMin, b.zMax, eps)) return false;

  const ahx = Math.max(0, a.hx - eps);
  const ahy = Math.max(0, a.hy - eps);
  const bhx = Math.max(0, b.hx - eps);
  const bhy = Math.max(0, b.hy - eps);
  const ac = Math.cos(a.angle);
  const as = Math.sin(a.angle);
  const bc = Math.cos(b.angle);
  const bs = Math.sin(b.angle);
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;

  // The box axes of both: (cos, sin) and (-sin, cos).
  const axes: [number, number][] = [
    [ac, as],
    [-as, ac],
    [bc, bs],
    [-bs, bc],
  ];
  for (const [ux, uy] of axes) {
    const ra = ahx * Math.abs(ux * ac + uy * as) + ahy * Math.abs(-ux * as + uy * ac);
    const rb = bhx * Math.abs(ux * bc + uy * bs) + bhy * Math.abs(-ux * bs + uy * bc);
    if (Math.abs(dx * ux + dy * uy) >= ra + rb) return false;
  }
  return true;
}

/** Height intervals overlap, each shrunk by `eps` at both ends but never past its middle. */
function intervalsOverlap(aMin: number, aMax: number, bMin: number, bMax: number, eps: number): boolean {
  const aMid = (aMin + aMax) / 2;
  const bMid = (bMin + bMax) / 2;
  return (
    Math.min(aMin + eps, aMid) < Math.max(bMax - eps, bMid) && Math.min(bMin + eps, bMid) < Math.max(aMax - eps, aMid)
  );
}

/**
 * Is the point strictly inside any of the boxes, each grown by `inflate` tiles in plan view? A point exactly on
 * a face is outside. Height is half open, `zMin <= z < zMax`, so a ground belt under a building counts as inside
 * and one lying on its roof does not. Pass `null` for `z` to ignore height (a footprint test).
 */
export function pointInOBBs(x: number, y: number, z: number | null, obbs: OBB2[], inflate: number): boolean {
  for (const o of obbs) {
    if (z !== null && !(z >= o.zMin - FACE_SLACK && z < o.zMax - FACE_SLACK)) continue;
    const dx = x - o.cx;
    const dy = y - o.cy;
    const c = Math.cos(o.angle);
    const s = Math.sin(o.angle);
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    if (Math.abs(lx) < o.hx + inflate - FACE_SLACK && Math.abs(ly) < o.hy + inflate - FACE_SLACK) return true;
  }
  return false;
}
