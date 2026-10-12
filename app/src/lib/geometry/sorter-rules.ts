// The length and alignment rules for a sorter's two ends: rule 8's distance part (1 m <= the 3D distance between the
// ends <= the reach) and rule 10 (the pick-to-drop direction within 14 / 11 degrees of each building slot's facing).
// One implementation for the two parties that must agree on it: the validator (`validate/geometry-checks.ts`) judges
// a finished layout with it, and the layout solver's tap assignment (`layout/taps.ts`) asks it before choosing a slot
// and span, so it never picks a sorter the validator would reject.
import type { GridPoint } from './model';
import { LEVEL, TILE } from './transform';

/** Two ends closer than this are a failed placement (MX §3.5). */
export const MIN_SORTER_LENGTH_M = 1;
/** Sorter skew limits in degrees: building to building, and with a belt end (MX §3.5, `TooSkew`). */
export const SKEW_LIMIT_BUILDING_DEG = 14;
export const SKEW_LIMIT_BELT_DEG = 11;

/** Float noise allowance on the distance limits, in metres. */
const REACH_SLACK_M = 1e-9;
/** Float noise allowance on the skew limit, in degrees. */
const SKEW_SLACK_DEG = 1e-9;
/** Plan-view distances (tiles) below this are no direction at all. */
const NO_DIRECTION_TILES = 1e-9;

/** The two ends of a sorter and what they sit on, as `sorterEnds` and the slots give them. */
export interface SorterEnds {
  pick: GridPoint;
  drop: GridPoint;
  /** The unit grid vector each end that is a building slot faces (east, north); empty for belt to belt. */
  facings: readonly (readonly [number, number])[];
  /** Does either end sit on a belt? The skew limit is 11 degrees then, else 14. */
  toBelt: boolean;
}

export type ReachProblem = { kind: 'too-close' | 'too-far'; meters: number };
export type SkewProblem =
  | { kind: 'no-direction'; limitDeg: number }
  | { kind: 'skew'; degrees: number; limitDeg: number; /** Index into `facings` of the one furthest off. */ facing: number };
export type SorterEndsProblem = ReachProblem | SkewProblem;

/** The 3D distance between two grid points, in metres. */
export function sorterLengthMeters(pick: GridPoint, drop: GridPoint): number {
  return Math.hypot((drop.x - pick.x) * TILE, (drop.y - pick.y) * TILE, (drop.z - pick.z) * LEVEL);
}

// mirrors: BuildTool_Inserter.CheckBuildConditions
/** Rule 8, distance part: `undefined` when 1 m <= the distance between the ends <= `maxReachMeters`. */
export function sorterReachProblem(pick: GridPoint, drop: GridPoint, maxReachMeters: number): ReachProblem | undefined {
  const meters = sorterLengthMeters(pick, drop);
  if (meters > maxReachMeters + REACH_SLACK_M) return { kind: 'too-far', meters };
  if (meters < MIN_SORTER_LENGTH_M - REACH_SLACK_M) return { kind: 'too-close', meters };
  return undefined;
}

// mirrors: BuildTool_Inserter.CheckBuildConditions
/**
 * Rule 10: the pick-to-drop direction in plan must align with each `facings` entry (or its reverse) within 14 degrees
 * (building to building) or 11 degrees (a belt end). No facings (belt to belt) means no rule. Ends at one point in
 * the plan have no direction to align.
 */
export function sorterSkewProblem(
  pick: GridPoint,
  drop: GridPoint,
  facings: readonly (readonly [number, number])[],
  toBelt: boolean,
): SkewProblem | undefined {
  if (facings.length === 0) return undefined;
  const limitDeg = toBelt ? SKEW_LIMIT_BELT_DEG : SKEW_LIMIT_BUILDING_DEG;
  const dx = drop.x - pick.x;
  const dy = drop.y - pick.y;
  const len = Math.hypot(dx, dy);
  if (len < NO_DIRECTION_TILES) return { kind: 'no-direction', limitDeg };
  let worst = 0;
  let facing = 0;
  facings.forEach((f, i) => {
    const cos = Math.min(1, Math.abs(dx * f[0] + dy * f[1]) / len);
    const angle = (Math.acos(cos) * 180) / Math.PI;
    if (angle > worst) {
      worst = angle;
      facing = i;
    }
  });
  return worst > limitDeg + SKEW_SLACK_DEG ? { kind: 'skew', degrees: worst, limitDeg, facing } : undefined;
}

/** What is wrong with a sorter's ends (the reach first, then the skew), or `undefined` when the validator accepts them. */
export function sorterEndsProblem(ends: SorterEnds, maxReachMeters: number): SorterEndsProblem | undefined {
  return sorterReachProblem(ends.pick, ends.drop, maxReachMeters) ?? sorterSkewProblem(ends.pick, ends.drop, ends.facings, ends.toBelt);
}

/** Would the validator accept a sorter with these ends (rule 8's distance part and rule 10)? */
export function sorterEndsValid(ends: SorterEnds, maxReachMeters: number): boolean {
  return sorterEndsProblem(ends, maxReachMeters) === undefined;
}
