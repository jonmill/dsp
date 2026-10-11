// The solver: the pipeline of Tasks 20-23 run as an anytime search (Task 24).
//
// Pipeline. One candidate is a placement taken through tap assignment, routing (elevation on), power nodes and
// assembly, then the validator's static checks (`validateLayout` with `simulate: false`: geometry, then the rate
// capacity). Only a candidate that would become the new best goes on to the full validator with the tick simulation,
// which is what costs time.
//
// Fallback ladder. First the constructive placement at margins 3, 4 and 6, in that order, until one candidate passes
// the full validator: that layout is emitted at once and is the guarantee. Margins this wide route reliably. The
// ladder is not cut short by the time budget or the early stop (only by the user); when every margin fails the result
// has no layout, `stoppedBy: 'exhausted'` and every violation message in `failures`.
//
// Improvement loop. Until a stop condition holds: pick a margin from {1, 2}, anneal the placement of the best layout
// (or, if that was made at a smaller margin than this one, the constructive placement at this margin: an annealed
// placement is only collision free at the margin it was annealed at) with a new seed, then build a candidate from it.
// Margins 0-2 often leave nets unrouted; a failed candidate is normal, is counted and the loop goes on. A candidate
// whose footprint is smaller than the best's goes to the full validator, and is emitted if it passes.
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
// too short, where the adaptive one only errs by stopping early; `validateWithRetry` covers that with one more run.
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
import { validateLayout } from '../validate';
import type { ValidateOptions, ValidationReport } from '../validate';
import { assembleLayout } from './assemble';
import { buildNetlist } from './netlist';
import type { Netlist } from './netlist';
import { obbsBounds, Occupancy } from './occupancy';
import { annealPlacement, constructivePlacement, DEFAULT_PLACEMENT_WEIGHTS, placementCost } from './placement';
import type { Placement } from './placement';
import { placePowerNodes, powerTargets } from './power';
import { Rng } from './rng';
import { defaultRouteParams, routeNets } from './router';
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
};

/** The fallback ladder's margins. */
const LADDER_MARGINS = [3, 4, 6] as const;
/** The improvement loop's margins. */
const IMPROVE_MARGINS = [1, 2] as const;

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
}

/** A target output short of the provisioned rate by less than this share is a near miss (see `validateWithRetry`). */
const NEAR_MISS = 0.02;
const TICKS_PER_SECOND = 60;
/** The longest warm-up the validator's adaptive warm-up runs (20 game minutes). */
const LONG_WARMUP_TICKS = 72_000;

/**
 * The full validator on `layout`, with one more try for a candidate the simulation rejects for a reason that may be
 * the length of the run rather than the layout (the verdict of the second run stands):
 *  - Long chains (Quantum Chips) oscillate around their rate by about 2 % from one 60 s window to the next, so a
 *    candidate whose only violation is SIM_OUTPUT_LOW, and short by under 2 %, is measured again over a window
 *    twice as long (an average over more cycles).
 *  - The adaptive warm-up ends once two windows agree, which a block still filling its belts can do on the way up
 *    (a six-stage Processor chain settles after 10 game minutes, the adaptive warm-up stopped at 2 to 4). When the
 *    caller left the warm-up to it and it ended before its 72000-tick cap, the second run warms up for the whole cap.
 * Nothing is retried after a deadlock, or when the caller fixed the warm-up and the shortfall is not a near miss.
 */
export function validateWithRetry(
  layout: Layout,
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  sim: SimSettings,
  validate: typeof validateLayout = validateLayout,
): ValidationReport {
  const opts: ValidateOptions = { simulate: sim.simulate, warmupTicks: sim.warmupTicks, measureTicks: sim.measureTicks };
  const first = validate(layout, plan, data, effects, opts);
  if (first.pass || !first.sim || first.sim.deadlocked) return first;

  const wanted = layout.meta.planTargetRate;
  const onlyLow = first.violations.length === 1 && first.violations[0].code === 'SIM_OUTPUT_LOW';
  const nearMiss = onlyLow && wanted > 0 && first.sim.measuredTargetRate >= (1 - NEAR_MISS) * wanted;
  const unsettled = sim.warmupTicks === undefined && first.sim.warmupTicksUsed < LONG_WARMUP_TICKS;
  if (!nearMiss && !unsettled) return first;

  const second: ValidateOptions = { ...opts };
  if (nearMiss) second.measureTicks = 2 * Math.round(first.sim.measureSeconds * TICKS_PER_SECOND);
  if (unsettled) second.warmupTicks = LONG_WARMUP_TICKS;
  return validate(layout, plan, data, effects, second);
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
// The search

interface Best extends MarginPlacement {
  layout: Layout;
  report: ValidationReport;
  footprint: number;
}

type Built = { layout: Layout } | { failures: string[] } | { stopped: true };

/** The violations of a report as messages. */
const violationMessages = (report: ValidationReport): string[] => report.violations.map((v) => `${v.code}: ${v.message}`);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * `solve` as a generator: it yields between candidates and returns the result. See the file comment.
 * `onProgress` is called once at the start, once after every candidate and once at the end (phase `'done'`);
 * `onImproved` for every layout that passes the full validator and has a smaller footprint than the one before.
 */
export function* solveSteps(
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  opts: SolveOptions,
  onProgress: (p: SolveProgress) => void,
  onImproved: (layout: Layout, report: ValidationReport, footprint: number) => void,
  shouldStop: () => boolean,
): Generator<void, SolveResult, void> {
  const now = opts.now ?? ((): number => performance.now());
  const startedAt = now();
  const elapsed = (): number => now() - startedAt;
  const sim: SimSettings = { simulate: opts.simulate, warmupTicks: opts.simWarmupTicks, measureTicks: opts.simMeasureTicks };
  const weights = DEFAULT_PLACEMENT_WEIGHTS;

  const net: Netlist = buildNetlist(plan, data, effects);
  const constructiveCache = new Map<number, Placement>();
  const constructive = (margin: number): Placement => {
    let p = constructiveCache.get(margin);
    if (!p) {
      p = constructivePlacement(net, data, margin);
      constructiveCache.set(margin, p);
    }
    return p;
  };

  let attempts = 0;
  let validated = 0;
  let best: Best | null = null;
  let lastImprovedAt = 0;
  let lastFailure: string | undefined;
  const failures: string[] = [];

  /** An internal error of the improvement loop goes into `failures` once, however often it repeats. */
  const noteInternalError = (message: string): void => {
    if (!failures.includes(message)) failures.push(message);
  };

  const progress = (phase: string): void =>
    onProgress({ elapsedMs: elapsed(), attempts, validated, bestFootprint: best?.footprint ?? null, phase, lastFailure });
  const result = (stoppedBy: SolveResult['stoppedBy']): SolveResult => {
    progress('done');
    return {
      layout: best?.layout ?? null,
      report: best?.report ?? null,
      footprint: best?.footprint ?? null,
      attempts,
      validated,
      stoppedBy,
      failures,
    };
  };

  /** A placement taken through taps, routes and power to a layout that passes the static checks. */
  const build = (placement: Placement, stop: () => boolean): Built => {
    const occ = new Occupancy(data);
    for (const b of placement.buildings) occ.addBuilding(b);
    const taps = assignTaps(net, placement, occ, data, effects);
    if ('failed' in taps) return { failures: [`tap assignment failed: ${taps.failed}`] };
    const routed = routeNets(net, taps, occ, defaultRouteParams(occ), stop);
    if (!routed.ok) {
      if (stop()) return { stopped: true };
      return { failures: [`routing left ${routed.conflicts} conflicts; nets without a route: ${routed.unroutable.join(', ') || 'none'}`] };
    }
    const bare = assembleLayout(net, placement, taps, routed.routes, [], plan, data);
    const targets = powerTargets(bare, data);
    const poles = placePowerNodes(bare.buildings, targets.consumerPoints, targets.blockedPoints, occ, data, effects);
    if (!poles) return { failures: ['no power node placement covers and links the layout'] };
    const layout = assembleLayout(net, placement, taps, routed.routes, poles, plan, data);
    const checked = validateLayout(layout, plan, data, effects, { simulate: false });
    if (!checked.pass) return { failures: violationMessages(checked) };
    return { layout };
  };

  /** Builds a candidate, turning a crash into a failure so one bad candidate never costs the best layout so far. */
  const tryBuild = (placement: Placement, stop: () => boolean): Built => {
    try {
      return build(placement, stop);
    } catch (err) {
      return { failures: [`internal error: ${err instanceof Error ? err.message : String(err)}`] };
    }
  };

  /** Runs the full validator on a candidate; a pass is the new best, and is emitted. */
  const accept = (layout: Layout, placed: MarginPlacement): Best | ValidationReport => {
    const report = validateWithRetry(layout, plan, data, effects, sim);
    if (!report.pass) return report;
    const footprint = footprintOf(layout, data);
    lastImprovedAt = elapsed();
    onImproved(layout, report, footprint);
    return { ...placed, layout, report, footprint };
  };

  // --- fallback ladder
  progress('start');
  for (const margin of LADDER_MARGINS) {
    yield;
    if (shouldStop()) return result('user');
    const placed: MarginPlacement = { placement: constructive(margin), margin };
    const built = tryBuild(placed.placement, shouldStop);
    attempts++;
    if ('stopped' in built) return result('user');
    if ('failures' in built) {
      const tagged = built.failures.map((f) => `margin ${margin}: ${f}`);
      failures.push(...tagged);
      lastFailure = tagged[0];
      progress(`ladder: margin ${margin} failed`);
      continue;
    }
    validated++;
    const accepted = accept(built.layout, placed);
    if ('layout' in accepted) {
      best = accepted;
      progress(`ladder: margin ${margin}`);
      break;
    }
    const tagged = violationMessages(accepted).map((f) => `margin ${margin}: ${f}`);
    failures.push(...tagged);
    lastFailure = tagged[0];
    progress(`ladder: margin ${margin} rejected`);
  }
  if (!best) return result(shouldStop() ? 'user' : 'exhausted');

  // --- improvement loop
  const rng = new Rng(opts.seed);
  const improveStop = (): boolean => shouldStop() || elapsed() >= opts.timeBudgetMs;
  let itersPerMs = DEFAULT_ITERS_PER_MS;
  const stopReason = (): SolveResult['stoppedBy'] | null => {
    if (shouldStop()) return 'user';
    const t = elapsed();
    if (t >= opts.timeBudgetMs) return 'budget';
    if (t >= opts.minRunMs && t - lastImprovedAt >= opts.earlyStopFraction * t) return 'early';
    return null;
  };

  for (;;) {
    yield;
    const stop = stopReason();
    if (stop) return result(stop);

    const current: Best = best;
    const margin = IMPROVE_MARGINS[rng.int(IMPROVE_MARGINS.length)];
    const seed = rng.int(0x7fffffff);
    const start = annealStart(current, margin, constructive);
    const startCost = placementCost(net, data, start.placement.buildings, weights);

    const slotMs = clamp((opts.timeBudgetMs - elapsed()) * SLICE_SHARE, MIN_SLICE_MS, MAX_SLICE_MS);
    const iterations = Math.round(clamp(slotMs * itersPerMs, MIN_ITERS, Math.max(MIN_ITERS, net.machines.length * MAX_ITERS_PER_MACHINE)));
    const annealStarted = now();
    let annealed: Placement;
    try {
      annealed = annealPlacement(
        net,
        data,
        start.placement,
        { margin, seed, iterations, startTemp: Math.max(START_TEMP_SHARE * startCost, COST_EPS), weights },
        improveStop,
      );
    } catch (err) {
      attempts++;
      lastFailure = `internal error: ${err instanceof Error ? err.message : String(err)}`;
      noteInternalError(`margin ${margin}: ${lastFailure}`);
      progress(`improve: margin ${margin} errored`);
      continue;
    }
    const annealMs = now() - annealStarted;
    if (annealMs >= MIN_TIMED_MS && !improveStop()) itersPerMs = (itersPerMs + iterations / annealMs) / 2;

    attempts++;
    if (start.placement === current.placement && annealed.cost >= startCost - COST_EPS) {
      // the anneal found nothing better than the placement of the best layout: nothing new to build
      lastFailure = `margin ${margin}: the anneal found no better placement`;
      progress(`improve: margin ${margin}, no better placement`);
      continue;
    }

    const placed: MarginPlacement = { placement: annealed, margin };
    const built = tryBuild(annealed, improveStop);
    if ('stopped' in built) {
      progress(`improve: margin ${margin} stopped`);
      continue;
    }
    if ('failures' in built) {
      lastFailure = `margin ${margin}: ${built.failures[0]}`;
      if (built.failures[0].startsWith('internal error')) noteInternalError(lastFailure);
      progress(`improve: margin ${margin} failed`);
      continue;
    }
    validated++;
    const footprint = footprintOf(built.layout, data);
    if (footprint >= current.footprint - FOOTPRINT_EPS) {
      lastFailure = undefined;
      progress(`improve: margin ${margin}, no smaller (${footprint.toFixed(0)} against ${current.footprint.toFixed(0)})`);
      continue;
    }
    const accepted = accept(built.layout, placed);
    if ('layout' in accepted) {
      best = accepted;
      lastFailure = undefined;
      progress(`improve: margin ${margin}, footprint ${footprint.toFixed(0)}`);
    } else {
      lastFailure = `margin ${margin}: ${violationMessages(accepted)[0]}`;
      progress(`improve: margin ${margin} rejected by the simulation`);
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
): SolveResult {
  const steps = solveSteps(plan, data, effects, opts, onProgress, onImproved, shouldStop);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
