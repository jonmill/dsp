// Coordinate transforms between prefab space (metres) and grid space (tiles, levels), and belt headings.
// The yaw convention is an assumption until checked in game (global context, "Coordinates"): it lives in
// `rotateYaw`, so a fix is one edit here.
import type { Quat, Vec3 } from '../data';
import type { GridPoint, Yaw } from './model';

/** Grid tile in metres: 2π·200/1000 at the equator. */
export const TILE = 1.2566370614359172;
/** Height level in metres. */
export const LEVEL = 4 / 3;

const YAW_TRIG: Record<Yaw, readonly [cos: number, sin: number]> = {
  0: [1, 0],
  90: [0, 1],
  180: [-1, 0],
  270: [0, -1],
};

/**
 * Turn an (east, north) vector clockwise by `yaw` degrees, viewed from above: north becomes east at yaw 90.
 * Exact for the four quarter turns (no sin/cos noise) and never returns -0. Applied to prefab (right, forward)
 * it gives the building's (east, north): `east = right·cosθ + forward·sinθ`, `north = −right·sinθ + forward·cosθ`.
 */
export function rotateYaw(east: number, north: number, yaw: Yaw): [number, number] {
  const trig = YAW_TRIG[yaw];
  if (!trig) throw new Error(`unsupported yaw ${String(yaw)} (expected 0, 90, 180 or 270)`);
  const [cos, sin] = trig;
  return [east * cos + north * sin + 0, -east * sin + north * cos + 0];
}

/**
 * Prefab space (metres; px right, py up, pz forward) to grid space for a building at `b` with yaw `b.yaw`
 * degrees clockwise from north, viewed from above, then metres to tiles and levels. This convention is an
 * assumption until checked in-game; keep it here.
 */
export function prefabToGrid(b: { x: number; y: number; z: number; yaw: Yaw }, p: Vec3): GridPoint {
  const [east, north] = rotateYaw(p[0], p[2], b.yaw);
  return { x: b.x + east / TILE, y: b.y + north / TILE, z: b.z + p[1] / LEVEL };
}

/**
 * Unit facing in grid (east, north) of a prefab-space rotation `q` (x, y, z, w), for a building at `yaw`:
 * prefab forward (+pz) turned by `q`, then by the building's yaw. Throws if `q` points straight up or down.
 */
export function prefabDirToGrid(yaw: Yaw, q: Quat): [number, number] {
  const [qx, qy, qz, qw] = q;
  const [east, north] = rotateYaw(2 * (qx * qz + qw * qy), 1 - 2 * (qx * qx + qy * qy), yaw);
  const len = Math.hypot(east, north);
  if (len < 1e-9) throw new Error('facing is vertical: it has no direction in the grid plane');
  return [east / len + 0, north / len + 0];
}

/** Yaw in degrees clockwise from north, in [0, 360), for a grid-space direction (east, north). */
export function headingDeg(east: number, north: number): number {
  const deg = Math.round(((Math.atan2(east, north) * 180) / Math.PI) * 1e6) / 1e6;
  return ((deg % 360) + 360) % 360;
}

/** Headings closer than this many degrees are the same heading. */
const SAME_HEADING_DEG = 1e-4;

/**
 * Yaw of every node of a belt polyline (degrees clockwise from north, as the game writes them).
 *
 * - A straight node, and the first node, take the heading toward the next point.
 * - The last node keeps the heading it arrived with.
 * - A corner (the heading changes) takes the bisector of the incoming and outgoing headings, the shorter way
 *   round: east in, south out gives 135. Real game exports do this (capsule sample record 101 at (15,22) is 135).
 * - A node whose next point is straight above or below (a vertical lift) carries the heading it arrived with, and
 *   a belt that starts with a lift takes its first real heading. A lift segment has no heading, so it never makes
 *   a corner.
 */
export function beltNodeYaws(pts: GridPoint[]): number[] {
  // Heading of the segment leaving each point; undefined where the next point is straight above or below.
  const out: (number | undefined)[] = pts.map((p, i) => {
    const next = pts[i + 1];
    if (!next) return undefined;
    const east = next.x - p.x;
    const north = next.y - p.y;
    return Math.hypot(east, north) > 1e-9 ? headingDeg(east, north) : undefined;
  });

  const yaws: (number | undefined)[] = [];
  let carry: number | undefined;
  for (let i = 0; i < pts.length; i++) {
    const leaving = out[i];
    const arriving = i > 0 ? out[i - 1] : undefined;
    if (leaving !== undefined) carry = leaving;
    if (arriving !== undefined && leaving !== undefined && headingGap(arriving, leaving) > SAME_HEADING_DEG) {
      yaws.push(bisector(arriving, leaving));
    } else {
      yaws.push(carry);
    }
  }
  const first = yaws.find((v) => v !== undefined) ?? 0;
  return yaws.map((v) => v ?? first);
}

/** Signed turn from heading `a` to heading `b`, in (-180, 180]. */
function turn(a: number, b: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

const headingGap = (a: number, b: number): number => Math.abs(turn(a, b));

/** Heading halfway through the turn from `a` to `b` (a U-turn bisects to the right of `a`). */
function bisector(a: number, b: number): number {
  const deg = Math.round((a + turn(a, b) / 2) * 1e6) / 1e6;
  return ((deg % 360) + 360) % 360;
}
