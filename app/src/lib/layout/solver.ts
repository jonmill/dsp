// The solver: the pipeline of Tasks 20-23 run as an anytime search (Task 24).
//
// Pipeline. One candidate is a placement taken through tap assignment, routing (elevation on), power nodes and
// assembly, then the validator's static checks (`validateLayout` with `simulate: false`: geometry, then the rate
// capacity). Only a candidate that would become the new best goes on to the full validator with the tick simulation,
// which is what costs time.
//
// Fallback ladder. First the constructive placement at margins 3, 4 and 6, in that order, until one candidate passes
// the full validator: that layout is emitted at once and is the guarantee. Margins this wide route reliably. The
// ladder is not cut short by the time budget or the early stop (only by the user, who also ends a simulation under way);
// when every rung fails the result has no layout, `stoppedBy: 'exhausted'` and every violation message in `failures`.
// Task 27 added two things. A layout that passes only over the doubled measure window of a near miss (`validateGated`)
// is kept for the end of the three rungs and a rung that passes the plain window is preferred to it, though it is no
// smaller: the first three rungs end the ladder with the first such layout if none passes the plain window (Hydrogen Fuel
// Rod needed the doubled window; its second rung passes the plain one). And when all three fail, the same margins are
// tried again with the exact router (`ladderRungs`): the simulated output of a plan with no slack swings by up to 10 %
// between two routings of one placement, and three layouts of one kind can fail together (Conveyor Belt MK.II).
//
// Improvement loop. Until a stop condition holds: pick a margin from {1, 2}, anneal the placement of the best layout
// (or, if that was made at a smaller margin than this one, the constructive placement at this margin: an annealed
// placement is only collision free at the margin it was annealed at) with a new seed, then build a candidate from it.
// Margins 0-2 often leave nets unrouted; a failed candidate is normal, is counted and the loop goes on. A candidate
// whose footprint is smaller than the best's goes to the full validator, and is emitted if it passes.
// Adaptive effort (Task 27). The margin is picked by the record of the margins so far (`MarginPicker`): margin 1 is
// often unroutable on large plans (a Quantum Chip candidate costs 25 s to fail), so its share shrinks, to 15 % at least,
// while it fails. A candidate gives up its routing when the negotiation stalls or is far from converging
// (`IMPROVE_STALL_ROUNDS`, `IMPROVE_HOPELESS`). Its simulation waits for the target to reach its rate for twice the
// warm-up of the best layout at most (`warmupCapFor`), not for the 72000 ticks of the adaptive limit: a candidate that
// settles within the cap warms up and measures exactly as plain `validateLayout` would, so what passes passes it too;
// and the simulation ends as soon as the budget is used up (`SimOptions.shouldAbort`), so a 60 s budget is not overrun by a
// 20 s simulation. The anneals of a chain start hotter the longer its best layout has stood (`Reheat`, for the anneals
// that have all the moves they can use): at the base temperature the chain finds nothing better round after round once it
// has reached its local best. The ordinary chain
// and the motif chains keep their own record of margins and their own temperature, so that the ordinary chain does the
// same with or without motifs.
//
// Motifs (Task 26). Behind `useUnverifiedMotifs` (and `VERIFIED_MOTIFS`, which ships empty) the loop also explores
// netlists that dense motifs have rewritten (motifs/index.ts: direct insertion, the shared-belt sandwich, lab stacks).
// After each ordinary iteration, with probability `MOTIF_SHARE`, one more iteration works on a motif variant: the
// netlist for a random subset of the enabled motifs, placed by its own chain of annealed placements (a placement keeps
// the motifs' groups rigid, so it cannot be annealed as the plain netlist). The ordinary chain is untouched by this
// (it has its own random source and its own best), so a run with motifs finds everything the run without them finds
// and, besides, the best of what the motif chains find. The emitted layout is the smallest of the two. Layouts pass the
// same validator, whichever chain made them.
//
// Footprint. The area, in tiles, of the box around every entity: the boxes of the buildings (poles included), the
// belt nodes and the ends of the sorters.
//
// Stops. 'user' (`shouldStop`), 'budget' (`timeBudgetMs` elapsed), 'early' (`minRunMs` elapsed and nothing improved
// in the last `earlyStopFraction` of the elapsed time; the moment the first layout was emitted counts as an
// improvement). They are checked between candidates; the budget and the user also cut a running anneal or routing short.
//
// Simulation. Left to the validator's defaults (adaptive warm-up, 18000 measured ticks) unless `simWarmupTicks` /
// `simMeasureTicks` say otherwise. A warm-up derived from the layout (belt length, chain depth) was not used: a
// six-stage Processor chain needs 10 game minutes to fill though its belts are short, so any such estimate can be
// too short; the adaptive warm-up keeps going until the target reaches its rate (or its 72000-tick cap).
//
// Time. `opts.now` is the clock (milliseconds); the default is `performance.now`. The result depends only on the
// inputs, `opts.seed` and the clock readings, so a test with a fake clock is deterministic.
//
// Steps. `solveSteps` is `solve` as a generator that yields between candidates, so a worker can look at its messages
// (a stop request) in between. `solve` runs it to the end.
import type { ProductionPlan } from '../calc';
import type { GameDataIndex, TechEffects } from '../data';
import { buildingDef, buildingOBBs, LayoutIndex, sorterEnds } from '../geometry';
import type { Layout } from '../geometry';
import { MAX_WARMUP_TICKS, SimulationAborted, validateLayout, WarmupNotSettled } from '../validate';
import type { ValidateOptions, ValidationReport } from '../validate';
import { assembleLayout } from './assemble';
import { applyMotifs, enabledMotifKinds, proposeMotifs } from './motifs';
import type { MotifKind } from './motifs';
import { buildNetlist } from './netlist';
import type { Netlist } from './netlist';
import { obbsBounds, Occupancy } from './occupancy';
import { annealPlacement, constructivePlacement, DEFAULT_PLACEMENT_WEIGHTS, placementCost } from './placement';
import type { Placement } from './placement';
import { placePowerNodes, powerTargets } from './power';
import { Rng } from './rng';
import { defaultRouteParams, routeNets } from './router';
import type { RouteParams } from './router';
import { assignTaps } from './taps';

export interface SolveOptions {
  /** Milliseconds the improvement loop may run (the fallback ladder is not bound by it). Default 600000. */
  timeBudgetMs: number;
  seed: number;
  /** The early stop applies from this much elapsed time. Default 30000. */
  minRunMs: number;
  /** Stop when nothing improved in the last this-share of the elapsed time. Default 0.2. */
  earlyStopFraction: number;
  /** Run the tick simulation as part of the full validation. */
  simulate: boolean;
  simWarmupTicks?: number;
  simMeasureTicks?: number;
  /**
   * Also use the dense motifs that have not been verified in game (motifs/index.ts). Default false: only the motifs in
   * `VERIFIED_MOTIFS` are used, and there are none yet.
   */
  useUnverifiedMotifs: boolean;
  /** The clock in milliseconds; injectable for tests. Default `performance.now`. */
  now?: () => number;
}

export interface SolveProgress {
  elapsedMs: number;
  /** Candidates built so far (ladder rungs and improvement iterations). */
  attempts: number;
  /** Candidates that passed the static checks. */
  validated: number;
  bestFootprint: number | null;
  phase: string;
  lastFailure?: string;
}

export interface SolveResult {
  layout: Layout | null;
  report: ValidationReport | null;
  footprint: number | null;
  attempts: number;
  validated: number;
  stoppedBy: 'budget' | 'early' | 'user' | 'exhausted';
  /** Why the ladder's margins failed (all violation messages), and any internal error of the improvement loop. */
  failures: string[];
}

export const DEFAULT_SOLVE_OPTIONS: SolveOptions = {
  timeBudgetMs: 600_000,
  seed: 1,
  minRunMs: 30_000,
  earlyStopFraction: 0.2,
  simulate: true,
  useUnverifiedMotifs: false,
};

/** The fallback ladder's margins. */
const LADDER_MARGINS = [3, 4, 6] as const;

/** One rung of the fallback ladder: a constructive placement at `margin`, routed by the fast router or the exact one. */
export interface Rung {
  margin: number;
  exact: boolean;
}

/**
 * The rungs of the fallback ladder in the order they are tried: margins 3, 4 and 6 with the fast router (weighted
 * heuristic, rerouting and give-up rules; see router.ts), then the same margins with the exact router (the routes
 * and the tap assignment that the ladder had before Task 27). The simulated output of a layout that has no slack in the
 * plan swings by 10 % from one routing of the same placement to another, and a ladder of three layouts of one kind can
 * fail them all (Conveyor Belt MK.II); the exact rungs are another chance that costs nothing when the first three pass.
 */
export function ladderRungs(): Rung[] {
  return [false, true].flatMap((exact) => LADDER_MARGINS.map((margin) => ({ margin, exact })));
}

/** The router's settings of an exact rung: A* without a weight and no rerouting of a failed net. */
const EXACT_ROUTE: Partial<RouteParams> = { heuristicWeight: 1, maxReorders: 0, maxNetFailures: Infinity };
/** The improvement loop's margins. */
const IMPROVE_MARGINS = [1, 2] as const;
/**
 * The improvement loop's candidates give up their routing after this many negotiation rounds in a row without a better
 * result (the ladder's routing never does: it is the guarantee). A negotiation that stays stuck this long resolves
 * rarely, and a failed candidate is only a lost iteration.
 */
const IMPROVE_STALL_ROUNDS = 10;
/**
 * ...and after this many rounds, when more than this many conflicts per net are left. Quantum Chip placements annealed at
 * margin 1 sit at 20-30 % of their first round's conflicts after 6 rounds (400-650 for 56 nets) and never converge, at
 * 25 s a try; the layouts that do converge (Quantum at margin 2, Processor at margin 1 or 2) have 2 conflicts per net
 * or fewer by then.
 */
const IMPROVE_HOPELESS = { afterRounds: 6, perNet: 4 };
/** The share of improvement iterations after which a motif iteration follows (when motifs are on). */
const MOTIF_SHARE = 0.5;
/** The motif chains' random source is the seed mixed with this, so the ordinary chain's draws are not touched. */
const MOTIF_SEED_MIX = 0x5bd1e995;

// ---------------------------------------------------------------------------------------------
// Annealing effort

/** Share of the remaining time one anneal may take, within the limits below. */
const SLICE_SHARE = 0.1;
const MIN_SLICE_MS = 250;
const MAX_SLICE_MS = 10_000;
/** Moves per millisecond assumed until one anneal has been timed (the Processor netlist manages 450-900). */
const DEFAULT_ITERS_PER_MS = 400;
/** An anneal gets at most this many moves per machine: beyond that it has converged, whatever the time. */
const MAX_ITERS_PER_MACHINE = 20_000;
const MIN_ITERS = 2_000;
/** An anneal that took less than this is too short to time. */
const MIN_TIMED_MS = 20;
/** The annealing temperature at the first move, as a share of the start placement's cost. */
const START_TEMP_SHARE = 0.02;
/** A cost has to be lower by this much to count as lower. */
const COST_EPS = 1e-9;
/** A footprint has to be smaller by this much to count as smaller. */
const FOOTPRINT_EPS = 1e-9;

// ---------------------------------------------------------------------------------------------
// Footprint

/** Plan-view area, in tiles, of the box around all buildings, belt nodes and sorter ends of `layout`; 0 if empty. */
export function footprintOf(layout: Layout, data: GameDataIndex): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const point = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const b of layout.buildings) {
    const box = obbsBounds(buildingOBBs(b, buildingDef(data, b.itemId)));
    point(box.minX, box.minY);
    point(box.maxX, box.maxY);
  }
  for (const belt of layout.belts) for (const n of belt.nodes) point(n.x, n.y);
  if (layout.sorters.length > 0) {
    const index = new LayoutIndex(layout);
    for (const s of layout.sorters) {
      const { pick, drop } = sorterEnds(s, layout, data, index);
      point(pick.x, pick.y);
      point(drop.x, drop.y);
    }
  }
  return maxX < minX ? 0 : (maxX - minX) * (maxY - minY);
}

// ---------------------------------------------------------------------------------------------
// Validation

export interface SimSettings {
  simulate: boolean;
  warmupTicks?: number;
  measureTicks?: number;
  /** Ends a long simulation when it says yes (`SimOptions.shouldAbort`). */
  shouldAbort?: () => boolean;
  /** An adaptive warm-up still short of the rate after this many ticks fails the candidate (`SimOptions.warmupCapTicks`). */
  warmupCapTicks?: number;
}

/** The adaptive warm-up of a candidate is given up on after this many times the best layout's warm-up... */
const WARMUP_CAP_FACTOR = 2;
/** ...but not before this many ticks (four of its 3600-tick windows), so a quick layout has room to fill. */
const MIN_WARMUP_CAP_TICKS = 14_400;

/**
 * How long the improvement loop waits for a candidate to reach its rate: twice the warm-up the best layout needed, within
 * [`MIN_WARMUP_CAP_TICKS`, `MAX_WARMUP_TICKS`]. The candidates of one plan fill alike, and a failing one would otherwise
 * run to the 72000-tick cap and measure 18000 more before it is turned down. A candidate that settles within the cap warms
 * up exactly as it would without it, so what passes is accepted by plain `validateLayout` too. `undefined`: no cap (the
 * best layout's warm-up is not known).
 */
export function warmupCapFor(best: ValidationReport | null | undefined): number | undefined {
  const used = best?.sim?.warmupTicksUsed;
  if (used === undefined) return undefined;
  return Math.min(MAX_WARMUP_TICKS, Math.max(MIN_WARMUP_CAP_TICKS, WARMUP_CAP_FACTOR * used));
}

/** A target output short of the provisioned rate by less than this share is a near miss (see `validateWithRetry`). */
const NEAR_MISS = 0.02;
const TICKS_PER_SECOND = 60;

/**
 * The full validator on `layout`. Plans of long chains (Quantum Chips) oscillate around their rate by about 2 % from
 * one 60 s window to the next, so a candidate whose only violation is SIM_OUTPUT_LOW, and short by under 2 %, is
 * validated once more with a measure window twice as long (an average over more cycles) before it is rejected. The
 * verdict of the longer window stands. (The warm-up is the caller's or the validator's business: a layout this accepts
 * is one that `validateLayout` accepts with the same options, up to the longer window.)
 */
export function validateWithRetry(
  layout: Layout,
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  sim: SimSettings,
  validate: typeof validateLayout = validateLayout,
): ValidationReport {
  return validateGated(layout, plan, data, effects, sim, validate).report;
}

/**
 * `validateWithRetry`, and whether the verdict is that of the doubled window (the first run was a near miss). A layout
 * that passes only over the doubled window passes plain `validateLayout` on a lucky window at best: the fallback ladder
 * keeps it for the end and prefers a layout that passes the plain one.
 */
export function validateGated(
  layout: Layout,
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  sim: SimSettings,
  validate: typeof validateLayout = validateLayout,
): { report: ValidationReport; longerWindow: boolean } {
  const opts: ValidateOptions = {
    simulate: sim.simulate,
    warmupTicks: sim.warmupTicks,
    measureTicks: sim.measureTicks,
    shouldAbort: sim.shouldAbort,
    warmupCapTicks: sim.warmupCapTicks,
  };
  const first = validate(layout, plan, data, effects, opts);
  if (first.pass || !first.sim) return { report: first, longerWindow: false };
  if (first.violations.length !== 1 || first.violations[0].code !== 'SIM_OUTPUT_LOW') return { report: first, longerWindow: false };
  const wanted = layout.meta.planTargetRate;
  if (!(wanted > 0) || first.sim.measuredTargetRate < (1 - NEAR_MISS) * wanted) return { report: first, longerWindow: false };
  const window = Math.round(first.sim.measureSeconds * TICKS_PER_SECOND);
  return { report: validate(layout, plan, data, effects, { ...opts, measureTicks: 2 * window }), longerWindow: true };
}

// ---------------------------------------------------------------------------------------------
// Placement bookkeeping

/** A placement and the margin it is collision free at. */
export interface MarginPlacement {
  placement: Placement;
  margin: number;
}

/**
 * Where an anneal at `margin` starts: the placement of the best layout if that was made at `margin` or wider (a
 * placement is collision free at every smaller margin than its own), else the constructive placement at `margin`.
 * `annealPlacement` throws on a start that collides at the margin it anneals at.
 */
export function annealStart(
  best: MarginPlacement | null,
  margin: number,
  constructive: (margin: number) => Placement,
): MarginPlacement {
  if (best && best.margin >= margin) return { placement: best.placement, margin };
  return { placement: constructive(margin), margin };
}

// ---------------------------------------------------------------------------------------------
// The improvement margin

/** The least share of the picks a margin keeps, whatever its record: a margin that failed early may still work later. */
const MIN_MARGIN_SHARE = 0.15;

/**
 * Chooses the margin of the next improvement candidate. A tight margin gives the smaller layouts but often cannot be
 * routed (Processor and Quantum Chip placements annealed at margin 1 mostly leave nets without a route, and a failed
 * routing costs seconds), so the picker follows the record: the share of a margin is its rate of candidates that were
 * built (taps, routes, power and the static checks), with one build in two tries as the starting point, floored at
 * `MIN_MARGIN_SHARE`. With no record every margin has the same share.
 */
export class MarginPicker {
  private readonly tries: number[];
  private readonly built: number[];

  constructor(private readonly margins: readonly number[]) {
    this.tries = margins.map(() => 0);
    this.built = margins.map(() => 0);
  }

  /** The chances of each margin, in the order of the margins; they add up to 1, and none is below `MIN_MARGIN_SHARE`. */
  shares(): number[] {
    const rate = this.margins.map((_, i) => (this.built[i] + 1) / (this.tries[i] + 2));
    const fixed = new Set<number>();
    const shares = rate.map(() => 0);
    // a margin under the minimum is held at it, and the others share what is left in proportion to their rates
    for (let round = 0; round <= rate.length; round++) {
      const free = rate.flatMap((r, i) => (fixed.has(i) ? [] : [r]));
      const pool = 1 - MIN_MARGIN_SHARE * fixed.size;
      const total = free.reduce((a, b) => a + b, 0);
      let again = false;
      rate.forEach((r, i) => {
        shares[i] = fixed.has(i) ? MIN_MARGIN_SHARE : (r / total) * pool;
        if (!fixed.has(i) && shares[i] < MIN_MARGIN_SHARE) {
          fixed.add(i);
          again = true;
        }
      });
      if (!again) break;
    }
    return shares;
  }

  /** The margin for `draw`, a number in [0, 1) from the chain's random source. */
  pick(draw: number): number {
    const shares = this.shares();
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      acc += shares[i];
      if (draw < acc) return this.margins[i];
    }
    return this.margins[this.margins.length - 1];
  }

  /** Records a candidate at `margin`: whether it was built. (A candidate cut short by a stop is not recorded.) */
  record(margin: number, built: boolean): void {
    const i = this.margins.indexOf(margin);
    if (i < 0) return;
    this.tries[i]++;
    if (built) this.built[i]++;
  }
}

// ---------------------------------------------------------------------------------------------
// Reheating

/** Each iteration that found no better layout raises the annealing temperature by this share of the base temperature... */
const HEAT_PER_STALE_ITERATION = 0.25;
/** ...up to this many times the base temperature. */
const MAX_HEAT = 8;

/**
 * How hot the next anneal starts. Once a chain has found its best placement, annealing from it at the base temperature
 * (2 % of its cost) finds nothing better round after round (Processor: 76 of 122 iterations of a 60 s run built a layout
 * that was no smaller, 20 more found no better placement; the best layout of a 60 s run was the one of 30 s). Every
 * such iteration of a chain therefore raises its temperature, a quarter of the base each, to 8 times at most, and a new
 * best layout of the chain brings it back (`annealHeat` leaves out the anneals that are short of moves). Over 8 seeds of
 * 60 s (six runs at once) the mean footprint came out 12 % lower for the Processor (805 to 705 tiles) and 8 % lower for the
 * Smelter Row (463 to 424); a gentler reheat (a tenth per iteration, to 3 times) gained 1 % and 5 %.
 */
export class Reheat {
  private stale = 0;

  /** The factor on the base temperature for the next anneal: 1 after an improvement, up to `MAX_HEAT`. */
  heat(): number {
    return Math.min(MAX_HEAT, 1 + HEAT_PER_STALE_ITERATION * this.stale);
  }

  /** An iteration ran. */
  iteration(): void {
    this.stale++;
  }

  /** The chain's best layout got smaller. */
  improved(): void {
    this.stale = 0;
  }
}

/**
 * The factor on the base temperature for an anneal that would like `wanted` moves and may have `cap` (see
 * `MAX_ITERS_PER_MACHINE`). Only an anneal that is capped, one that could use more time than it is given, is reheated:
 * a hotter anneal needs more moves to cool down, and a Quantum Chip anneal that the time limits to a fraction of the
 * moves it could use (2M of 4.6M) comes out worse, not better, from a higher start.
 */
export function annealHeat(reheat: Reheat, wanted: number, cap: number): number {
  return wanted >= cap ? reheat.heat() : 1;
}

// ---------------------------------------------------------------------------------------------
// The best layout

/**
 * The smallest layout found by any chain, and when it last got smaller: the early stop counts from that moment. A
 * layout that is not smaller (by more than float noise) changes nothing, the time included.
 */
export class BestKeeper<T extends { footprint: number }> {
  best: T | null = null;
  /** When `best` last got smaller (0 before the first layout). */
  improvedAt = 0;

  /** Takes `candidate`, found at time `at`, if it is smaller than the best; says whether it was. */
  offer(candidate: T, at: number): boolean {
    if (this.best && candidate.footprint >= this.best.footprint - FOOTPRINT_EPS) return false;
    this.best = candidate;
    this.improvedAt = at;
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// The search

interface Best extends MarginPlacement {
  layout: Layout;
  report: ValidationReport;
  footprint: number;
}

type Built = { layout: Layout; footprint: number } | { failures: string[] } | { stopped: true };

/** The violations of a report as messages. */
const violationMessages = (report: ValidationReport): string[] => report.violations.map((v) => `${v.code}: ${v.message}`);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * `solve` as a generator: it yields between candidates and returns the result. See the file comment.
 * `onProgress` is called once at the start, once after every candidate and once at the end (phase `'done'`);
 * `onImproved` for every layout that passes the full validator and has a smaller footprint than the one before.
 * `validate` is the full validator (`validateLayout`; a parameter for tests).
 */
export function* solveSteps(
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  opts: SolveOptions,
  onProgress: (p: SolveProgress) => void,
  onImproved: (layout: Layout, report: ValidationReport, footprint: number) => void,
  shouldStop: () => boolean,
  validate: typeof validateLayout = validateLayout,
): Generator<void, SolveResult, void> {
  const now = opts.now ?? ((): number => performance.now());
  const startedAt = now();
  const elapsed = (): number => now() - startedAt;
  const sim: SimSettings = { simulate: opts.simulate, warmupTicks: opts.simWarmupTicks, measureTicks: opts.simMeasureTicks };
  const weights = DEFAULT_PLACEMENT_WEIGHTS;

  const net: Netlist = buildNetlist(plan, data, effects);
  /** The constructive placements of `netlist` by margin, made when first asked for. */
  const constructiveOf = (netlist: Netlist): ((margin: number) => Placement) => {
    const cache = new Map<number, Placement>();
    return (margin) => {
      let p = cache.get(margin);
      if (!p) {
        p = constructivePlacement(netlist, data, margin);
        cache.set(margin, p);
      }
      return p;
    };
  };
  const constructive = constructiveOf(net);

  let attempts = 0;
  let validated = 0;
  /** The smallest layout found by any chain: what the result is and `onImproved` reports. */
  const keeper = new BestKeeper<Best>();
  /** The ordinary chain's own best: what its anneals start from. The keeper's best unless a motif chain has done better. */
  let baseBest: Best | null = null;
  let lastFailure: string | undefined;
  const failures: string[] = [];

  /** An internal error of the improvement loop goes into `failures` once, however often it repeats (or at which margin). */
  const noteInternalError = (margin: number, text: string): void => {
    if (!failures.some((f) => f.endsWith(text))) failures.push(`margin ${margin}: ${text}`);
  };

  const progress = (phase: string): void =>
    onProgress({ elapsedMs: elapsed(), attempts, validated, bestFootprint: keeper.best?.footprint ?? null, phase, lastFailure });
  const result = (stoppedBy: SolveResult['stoppedBy']): SolveResult => {
    progress('done');
    return {
      layout: keeper.best?.layout ?? null,
      report: keeper.best?.report ?? null,
      footprint: keeper.best?.footprint ?? null,
      attempts,
      validated,
      stoppedBy,
      failures,
    };
  };

  /**
   * A placement of `netlist` taken through taps, routes and power to a layout that passes the static checks. `route`
   * overrides the router's defaults (the improvement loop's candidates give up a stuck negotiation early); `exact`
   * assigns the taps in netlist order only (an exact rung of the ladder).
   */
  const build = (netlist: Netlist, placement: Placement, stop: () => boolean, route: Partial<RouteParams> = {}, exact = false): Built => {
    const occ = new Occupancy(data);
    for (const b of placement.buildings) occ.addBuilding(b);
    const taps = assignTaps(netlist, placement, occ, data, effects, { repass: !exact });
    if ('failed' in taps) return { failures: [`tap assignment failed: ${taps.failed}`] };
    const routed = routeNets(netlist, taps, occ, defaultRouteParams(occ, route), stop);
    if (!routed.ok) {
      if (stop()) return { stopped: true };
      return { failures: [`routing left ${routed.conflicts} conflicts; nets without a route: ${routed.unroutable.join(', ') || 'none'}`] };
    }
    const bare = assembleLayout(netlist, placement, taps, routed.routes, [], plan, data);
    const targets = powerTargets(bare, data);
    const poles = placePowerNodes(bare.buildings, targets.consumerPoints, targets.blockedPoints, occ, data, effects);
    if (!poles) return { failures: ['no power node placement covers and links the layout'] };
    const layout = assembleLayout(netlist, placement, taps, routed.routes, poles, plan, data);
    const checked = validateLayout(layout, plan, data, effects, { simulate: false });
    if (!checked.pass) return { failures: violationMessages(checked) };
    return { layout, footprint: footprintOf(layout, data) };
  };

  /** Builds a candidate, turning a crash into a failure so one bad candidate never costs the best layout so far. */
  const tryBuild = (netlist: Netlist, placement: Placement, stop: () => boolean, route: Partial<RouteParams> = {}, exact = false): Built => {
    try {
      return build(netlist, placement, stop, route, exact);
    } catch (err) {
      return { failures: [`internal error: ${err instanceof Error ? err.message : String(err)}`] };
    }
  };

  /**
   * Runs the full validator on a candidate. A pass is a new best of its chain (`adopt` makes it the overall best too if
   * it is smaller). A throw of the validator or the simulator is a failure of this candidate like any other, and so is a
   * candidate that is still short of its rate when `warmupCap` runs out. `abort` ends a simulation under way when it says
   * yes (the budget, or the user): the candidate is dropped (`stopped`), it is no failure.
   */
  const accept = (
    built: { layout: Layout; footprint: number },
    placed: MarginPlacement,
    abort: () => boolean,
    warmupCap?: number,
  ): { best: Best; longerWindow: boolean } | { failures: string[] } | { stopped: true } => {
    let report: ValidationReport;
    let longerWindow: boolean;
    try {
      ({ report, longerWindow } = validateGated(built.layout, plan, data, effects, { ...sim, shouldAbort: abort, warmupCapTicks: warmupCap }, validate));
    } catch (err) {
      if (err instanceof SimulationAborted) return { stopped: true };
      if (err instanceof WarmupNotSettled) return { failures: [`SIM_OUTPUT_LOW: ${err.message} (the improvement loop waits twice as long as the best layout did)`] };
      return { failures: [`internal error: ${err instanceof Error ? err.message : String(err)}`] };
    }
    if (!report.pass) return { failures: violationMessages(report) };
    return { best: { ...placed, layout: built.layout, report, footprint: built.footprint }, longerWindow };
  };

  /** Makes a layout that passed the full validator the overall best if it is smaller, and reports it. */
  const adopt = (candidate: Best): void => {
    if (keeper.offer(candidate, elapsed())) onImproved(candidate.layout, candidate.report, candidate.footprint);
  };

  // --- fallback ladder
  progress('start');
  const rungs = ladderRungs();
  /** The first layout that passed only over the doubled window; kept for the end of the ladder (see `validateGated`). */
  let provisional: { best: Best; tag: string } | null = null;
  for (const [i, rung] of rungs.entries()) {
    // the exact rungs are a second chance for a ladder that found nothing: a layout over the doubled window is enough
    if (provisional && i === LADDER_MARGINS.length) break;
    const { margin } = rung;
    const tag = rung.exact ? `margin ${margin} (exact routes)` : `margin ${margin}`;
    yield;
    if (shouldStop()) return result('user');
    const placed: MarginPlacement = { placement: constructive(margin), margin };
    const built = tryBuild(net, placed.placement, shouldStop, rung.exact ? EXACT_ROUTE : {}, rung.exact);
    attempts++;
    if ('stopped' in built) return result('user');
    if ('failures' in built) {
      const tagged = built.failures.map((f) => `${tag}: ${f}`);
      failures.push(...tagged);
      lastFailure = tagged[0];
      progress(`ladder: ${tag} failed`);
      continue;
    }
    validated++;
    // the ladder is the guarantee: no warm-up cap, and only the user stops it (the budget does not)
    const accepted = accept(built, placed, shouldStop);
    if ('stopped' in accepted) return result('user');
    if ('best' in accepted) {
      if (accepted.longerWindow) {
        provisional ??= { best: accepted.best, tag };
        progress(`ladder: ${tag} passes over the longer window only`);
        continue;
      }
      baseBest = accepted.best;
      adopt(accepted.best);
      progress(`ladder: ${tag}`);
      break;
    }
    const tagged = accepted.failures.map((f) => `${tag}: ${f}`);
    failures.push(...tagged);
    lastFailure = tagged[0];
    progress(`ladder: ${tag} rejected`);
  }
  if (!baseBest && provisional) {
    baseBest = provisional.best;
    adopt(provisional.best);
    progress(`ladder: ${provisional.tag}, over the longer window`);
  }
  if (!keeper.best || !baseBest) return result(shouldStop() ? 'user' : 'exhausted');

  // --- improvement loop
  const rng = new Rng(opts.seed);
  const improveStop = (): boolean => shouldStop() || elapsed() >= opts.timeBudgetMs;
  // Each chain has its own record of margins and its own temperature, so that the ordinary chain does exactly the same
  // whether the motif chains run or not.
  const marginPicker = new MarginPicker(IMPROVE_MARGINS);
  const reheat = new Reheat();
  /** How the improvement loop builds a candidate: a routing that is stuck is given up early. */
  const IMPROVE_ROUTE: Partial<RouteParams> = { stallRounds: IMPROVE_STALL_ROUNDS, hopeless: IMPROVE_HOPELESS };
  let itersPerMs = DEFAULT_ITERS_PER_MS;
  const stopReason = (): SolveResult['stoppedBy'] | null => {
    if (shouldStop()) return 'user';
    const t = elapsed();
    if (t >= opts.timeBudgetMs) return 'budget';
    if (t >= opts.minRunMs && t - keeper.improvedAt >= opts.earlyStopFraction * t) return 'early';
    return null;
  };

  /** Moves of an anneal: as many as the time left allows (within limits), timed to learn how many fit in a millisecond. */
  const annealWith = (
    netlist: Netlist,
    start: Placement,
    startCost: number,
    margin: number,
    seed: number,
    reheat: Reheat,
  ): { annealed: Placement } | { error: string } => {
    const slotMs = clamp((opts.timeBudgetMs - elapsed()) * SLICE_SHARE, MIN_SLICE_MS, MAX_SLICE_MS);
    const wanted = slotMs * itersPerMs;
    const cap = Math.max(MIN_ITERS, netlist.machines.length * MAX_ITERS_PER_MACHINE);
    const iterations = Math.round(clamp(wanted, MIN_ITERS, cap));
    const heat = annealHeat(reheat, wanted, cap);
    const annealStarted = now();
    let annealed: Placement;
    try {
      annealed = annealPlacement(
        netlist,
        data,
        start,
        { margin, seed, iterations, startTemp: Math.max(START_TEMP_SHARE * heat * startCost, COST_EPS), weights },
        improveStop,
      );
    } catch (err) {
      return { error: `internal error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const annealMs = now() - annealStarted;
    if (annealMs >= MIN_TIMED_MS && !improveStop()) itersPerMs = (itersPerMs + iterations / annealMs) / 2;
    return { annealed };
  };

  /** One iteration of the ordinary chain: anneal the placement of its best layout, build, and validate if smaller. */
  const baseIteration = (): void => {
    const current: Best = baseBest as Best;
    reheat.iteration();
    const margin = marginPicker.pick(rng.next());
    const seed = rng.int(0x7fffffff);
    const start = annealStart(current, margin, constructive);
    const startCost = placementCost(net, data, start.placement.buildings, weights);

    const outcome = annealWith(net, start.placement, startCost, margin, seed, reheat);
    if ('error' in outcome) {
      attempts++;
      lastFailure = outcome.error;
      noteInternalError(margin, lastFailure);
      progress(`improve: margin ${margin} errored`);
      return;
    }
    const { annealed } = outcome;

    attempts++;
    if (start.placement === current.placement && annealed.cost >= startCost - COST_EPS) {
      // the anneal found nothing better than the placement of the best layout: nothing new to build
      lastFailure = `margin ${margin}: the anneal found no better placement`;
      progress(`improve: margin ${margin}, no better placement`);
      return;
    }

    const placed: MarginPlacement = { placement: annealed, margin };
    const built = tryBuild(net, annealed, improveStop, IMPROVE_ROUTE);
    if ('stopped' in built) {
      progress(`improve: margin ${margin} stopped`);
      return;
    }
    marginPicker.record(margin, !('failures' in built));
    if ('failures' in built) {
      lastFailure = `margin ${margin}: ${built.failures[0]}`;
      if (built.failures[0].startsWith('internal error')) noteInternalError(margin, built.failures[0]);
      progress(`improve: margin ${margin} failed`);
      return;
    }
    validated++;
    if (built.footprint >= current.footprint - FOOTPRINT_EPS) {
      lastFailure = undefined;
      progress(`improve: margin ${margin}, no smaller (${built.footprint.toFixed(0)} against ${current.footprint.toFixed(0)})`);
      return;
    }
    const accepted = accept(built, placed, improveStop, warmupCapFor(current.report));
    if ('stopped' in accepted) {
      progress(`improve: margin ${margin} stopped`);
    } else if ('best' in accepted) {
      baseBest = accepted.best;
      reheat.improved();
      adopt(accepted.best);
      lastFailure = undefined;
      progress(`improve: margin ${margin}, footprint ${built.footprint.toFixed(0)}`);
    } else {
      lastFailure = `margin ${margin}: ${accepted.failures[0]}`;
      if (accepted.failures[0].startsWith('internal error')) noteInternalError(margin, accepted.failures[0]);
      progress(`improve: margin ${margin} rejected by the simulation`);
    }
  };

  // --- motif chains
  /** A netlist rewritten by the motifs of `kinds`, and the best placements found for it. */
  interface Variant {
    kinds: MotifKind[];
    net: Netlist;
    constructive: (margin: number) => Placement;
    /**
     * The smallest layout of this variant that starts the next anneal: one the full validator passed, or one that was
     * not below the overall best (the validator has no use for those). Never a layout the validator turned down.
     */
    best: (MarginPlacement & { footprint: number }) | null;
  }
  const motifKinds = enabledMotifKinds(opts.useUnverifiedMotifs);
  const motifMarginPicker = new MarginPicker(IMPROVE_MARGINS);
  const motifReheat = new Reheat();
  let variants: Variant[] | null = null;
  let motifsOff = motifKinds.size === 0;
  const motifRng = new Rng((opts.seed ^ MOTIF_SEED_MIX) >>> 0);

  /** The variants: one per non-empty subset of the enabled motifs that changes the netlist, the fewest motifs first. */
  const makeVariants = (): Variant[] => {
    const kinds = [...motifKinds].sort();
    const subsets: MotifKind[][] = [];
    for (let mask = 1; mask < 1 << kinds.length; mask++) subsets.push(kinds.filter((_, i) => mask & (1 << i)));
    subsets.sort((a, b) => a.length - b.length);
    const made: Variant[] = [];
    const seen = new Set<string>();
    for (const subset of subsets) {
      const instances = proposeMotifs(net, data, effects, new Set(subset));
      if (instances.length === 0) continue;
      const key = JSON.stringify(instances.map((i) => i.machineIds));
      if (seen.has(key)) continue; // another set of motifs makes the same groups
      seen.add(key);
      const variantNet = applyMotifs(net, instances, data, effects);
      made.push({ kinds: subset, net: variantNet, constructive: constructiveOf(variantNet), best: null });
    }
    return made;
  };

  /** One iteration of a motif chain: as `baseIteration`, on the netlist of a random variant. */
  const motifIteration = (): void => {
    if (variants === null) {
      try {
        variants = makeVariants();
      } catch (err) {
        variants = [];
        lastFailure = `internal error: ${err instanceof Error ? err.message : String(err)}`;
        noteInternalError(0, lastFailure);
      }
      if (variants.length === 0) motifsOff = true;
    }
    if (variants.length === 0) return;
    // half the time the variant with the most motifs, else any
    const variant = variants[motifRng.next() < 0.5 ? variants.length - 1 : motifRng.int(variants.length)];
    const name = variant.kinds.join('+');
    motifReheat.iteration();
    const margin = motifMarginPicker.pick(motifRng.next());
    const seed = motifRng.int(0x7fffffff);
    const start = annealStart(variant.best, margin, variant.constructive);
    const startCost = placementCost(variant.net, data, start.placement.buildings, weights);

    const outcome = annealWith(variant.net, start.placement, startCost, margin, seed, motifReheat);
    attempts++;
    if ('error' in outcome) {
      lastFailure = outcome.error;
      noteInternalError(margin, lastFailure);
      progress(`motif ${name}: margin ${margin} errored`);
      return;
    }
    const { annealed } = outcome;
    if (variant.best && start.placement === variant.best.placement && annealed.cost >= startCost - COST_EPS) {
      lastFailure = `motif ${name}, margin ${margin}: the anneal found no better placement`;
      progress(`motif ${name}: margin ${margin}, no better placement`);
      return;
    }

    const placed: MarginPlacement = { placement: annealed, margin };
    const built = tryBuild(variant.net, annealed, improveStop, IMPROVE_ROUTE);
    if ('stopped' in built) {
      progress(`motif ${name}: margin ${margin} stopped`);
      return;
    }
    motifMarginPicker.record(margin, !('failures' in built));
    if ('failures' in built) {
      lastFailure = `motif ${name}, margin ${margin}: ${built.failures[0]}`;
      if (built.failures[0].startsWith('internal error')) noteInternalError(margin, built.failures[0]);
      progress(`motif ${name}: margin ${margin} failed`);
      return;
    }
    validated++;
    if (variant.best && built.footprint >= variant.best.footprint - FOOTPRINT_EPS) {
      lastFailure = undefined;
      progress(`motif ${name}: margin ${margin}, no smaller (${built.footprint.toFixed(0)} against ${variant.best.footprint.toFixed(0)})`);
      return;
    }
    const overall = (keeper.best as Best).footprint;
    if (built.footprint >= overall - FOOTPRINT_EPS) {
      // not below the overall best, so the full validator has no use for it; it is the next start of this variant
      variant.best = { ...placed, footprint: built.footprint };
      motifReheat.improved();
      lastFailure = undefined;
      progress(`motif ${name}: margin ${margin}, footprint ${built.footprint.toFixed(0)}, not below ${overall.toFixed(0)}`);
      return;
    }
    // a candidate for the overall best: the full validator decides. Only a layout that passes it starts the variant's
    // next anneal (a rejected one would also keep every later candidate of its size out of the validator).
    const accepted = accept(built, placed, improveStop, warmupCapFor((keeper.best as Best).report));
    if ('stopped' in accepted) {
      progress(`motif ${name}: margin ${margin} stopped`);
    } else if ('best' in accepted) {
      variant.best = { ...placed, footprint: built.footprint };
      motifReheat.improved();
      adopt(accepted.best);
      lastFailure = undefined;
      progress(`motif ${name}: margin ${margin}, footprint ${built.footprint.toFixed(0)}`);
    } else {
      lastFailure = `motif ${name}, margin ${margin}: ${accepted.failures[0]}`;
      if (accepted.failures[0].startsWith('internal error')) noteInternalError(margin, accepted.failures[0]);
      progress(`motif ${name}: margin ${margin} rejected by the simulation`);
    }
  };

  for (;;) {
    yield;
    const stop = stopReason();
    if (stop) return result(stop);
    baseIteration();
    if (!motifsOff && motifRng.next() < MOTIF_SHARE) {
      yield;
      const stopMotif = stopReason();
      if (stopMotif) return result(stopMotif);
      motifIteration();
    }
  }
}

/**
 * Finds the layout of `plan` that passes the full validator and has the smallest footprint, within the time budget:
 * see the file comment. Never throws for a candidate that fails; throws only if the plan cannot be turned into a netlist.
 */
export function solve(
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  opts: SolveOptions,
  onProgress: (p: SolveProgress) => void,
  onImproved: (layout: Layout, report: ValidationReport, footprint: number) => void,
  shouldStop: () => boolean,
  validate: typeof validateLayout = validateLayout,
): SolveResult {
  const steps = solveSteps(plan, data, effects, opts, onProgress, onImproved, shouldStop, validate);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
