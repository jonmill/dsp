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
import { validateLayout } from '../validate';
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
/** The improvement loop's margins. */
const IMPROVE_MARGINS = [1, 2] as const;
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
  const opts: ValidateOptions = { simulate: sim.simulate, warmupTicks: sim.warmupTicks, measureTicks: sim.measureTicks };
  const first = validate(layout, plan, data, effects, opts);
  if (first.pass || !first.sim) return first;
  if (first.violations.length !== 1 || first.violations[0].code !== 'SIM_OUTPUT_LOW') return first;
  const wanted = layout.meta.planTargetRate;
  if (!(wanted > 0) || first.sim.measuredTargetRate < (1 - NEAR_MISS) * wanted) return first;
  const window = Math.round(first.sim.measureSeconds * TICKS_PER_SECOND);
  return validate(layout, plan, data, effects, { ...opts, measureTicks: 2 * window });
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

  /** A placement of `netlist` taken through taps, routes and power to a layout that passes the static checks. */
  const build = (netlist: Netlist, placement: Placement, stop: () => boolean): Built => {
    const occ = new Occupancy(data);
    for (const b of placement.buildings) occ.addBuilding(b);
    const taps = assignTaps(netlist, placement, occ, data, effects);
    if ('failed' in taps) return { failures: [`tap assignment failed: ${taps.failed}`] };
    const routed = routeNets(netlist, taps, occ, defaultRouteParams(occ), stop);
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
  const tryBuild = (netlist: Netlist, placement: Placement, stop: () => boolean): Built => {
    try {
      return build(netlist, placement, stop);
    } catch (err) {
      return { failures: [`internal error: ${err instanceof Error ? err.message : String(err)}`] };
    }
  };

  /**
   * Runs the full validator on a candidate. A pass is a new best of its chain (`adopt` makes it the overall best too if
   * it is smaller). A throw of the validator or the simulator is a failure of this candidate like any other.
   */
  const accept = (built: { layout: Layout; footprint: number }, placed: MarginPlacement): { best: Best } | { failures: string[] } => {
    let report: ValidationReport;
    try {
      report = validateWithRetry(built.layout, plan, data, effects, sim, validate);
    } catch (err) {
      return { failures: [`internal error: ${err instanceof Error ? err.message : String(err)}`] };
    }
    if (!report.pass) return { failures: violationMessages(report) };
    return { best: { ...placed, layout: built.layout, report, footprint: built.footprint } };
  };

  /** Makes a layout that passed the full validator the overall best if it is smaller, and reports it. */
  const adopt = (candidate: Best): void => {
    if (keeper.offer(candidate, elapsed())) onImproved(candidate.layout, candidate.report, candidate.footprint);
  };

  // --- fallback ladder
  progress('start');
  for (const margin of LADDER_MARGINS) {
    yield;
    if (shouldStop()) return result('user');
    const placed: MarginPlacement = { placement: constructive(margin), margin };
    const built = tryBuild(net, placed.placement, shouldStop);
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
    const accepted = accept(built, placed);
    if ('best' in accepted) {
      baseBest = accepted.best;
      adopt(accepted.best);
      progress(`ladder: margin ${margin}`);
      break;
    }
    const tagged = accepted.failures.map((f) => `margin ${margin}: ${f}`);
    failures.push(...tagged);
    lastFailure = tagged[0];
    progress(`ladder: margin ${margin} rejected`);
  }
  if (!keeper.best || !baseBest) return result(shouldStop() ? 'user' : 'exhausted');

  // --- improvement loop
  const rng = new Rng(opts.seed);
  const improveStop = (): boolean => shouldStop() || elapsed() >= opts.timeBudgetMs;
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
  ): { annealed: Placement } | { error: string } => {
    const slotMs = clamp((opts.timeBudgetMs - elapsed()) * SLICE_SHARE, MIN_SLICE_MS, MAX_SLICE_MS);
    const iterations = Math.round(clamp(slotMs * itersPerMs, MIN_ITERS, Math.max(MIN_ITERS, netlist.machines.length * MAX_ITERS_PER_MACHINE)));
    const annealStarted = now();
    let annealed: Placement;
    try {
      annealed = annealPlacement(
        netlist,
        data,
        start,
        { margin, seed, iterations, startTemp: Math.max(START_TEMP_SHARE * startCost, COST_EPS), weights },
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
    const margin = IMPROVE_MARGINS[rng.int(IMPROVE_MARGINS.length)];
    const seed = rng.int(0x7fffffff);
    const start = annealStart(current, margin, constructive);
    const startCost = placementCost(net, data, start.placement.buildings, weights);

    const outcome = annealWith(net, start.placement, startCost, margin, seed);
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
    const built = tryBuild(net, annealed, improveStop);
    if ('stopped' in built) {
      progress(`improve: margin ${margin} stopped`);
      return;
    }
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
    const accepted = accept(built, placed);
    if ('best' in accepted) {
      baseBest = accepted.best;
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
    const margin = IMPROVE_MARGINS[motifRng.int(IMPROVE_MARGINS.length)];
    const seed = motifRng.int(0x7fffffff);
    const start = annealStart(variant.best, margin, variant.constructive);
    const startCost = placementCost(variant.net, data, start.placement.buildings, weights);

    const outcome = annealWith(variant.net, start.placement, startCost, margin, seed);
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
    const built = tryBuild(variant.net, annealed, improveStop);
    if ('stopped' in built) {
      progress(`motif ${name}: margin ${margin} stopped`);
      return;
    }
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
      lastFailure = undefined;
      progress(`motif ${name}: margin ${margin}, footprint ${built.footprint.toFixed(0)}, not below ${overall.toFixed(0)}`);
      return;
    }
    // a candidate for the overall best: the full validator decides. Only a layout that passes it starts the variant's
    // next anneal (a rejected one would also keep every later candidate of its size out of the validator).
    const accepted = accept(built, placed);
    if ('best' in accepted) {
      variant.best = { ...placed, footprint: built.footprint };
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
