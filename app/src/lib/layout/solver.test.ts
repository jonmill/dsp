import { describe, expect, it, vi } from 'vitest';
import type { ProductionPlan } from '../calc';
import type { Layout, PlacedBuilding } from '../geometry';
import { LayoutKit, compositeLayout } from '../validate/testkit';
import { MAX_WARMUP_TICKS, validateLayout } from '../validate';
import type { ValidateOptions, ValidationReport } from '../validate';
import type { SimResult } from '../validate/sim/run';
import { annealStart, DEFAULT_SOLVE_OPTIONS, footprintOf, solve, solveSteps, validateWithRetry } from './solver';
import type { SolveOptions, SolveProgress, SolveResult } from './solver';
import { ASSEMBLER, data, effects, occupancyOf, planFor, SMELTER } from './testkit';

/** 3 Iron Ingots/s on three smelters from supplied Iron Ore: three machines, one station. Small and quick to solve. */
const ingotPlan = (): Promise<ProductionPlan> =>
  planFor({
    targetItemId: 1101,
    finalFacilityItemId: SMELTER,
    quantity: { kind: 'rate', perSecond: 3 },
    suppliedItemIds: new Set([1001]),
  });

/** Short simulation windows keep the unit tests quick; the plans are simple enough to settle within them. */
const SIM = { simWarmupTicks: 1200, simMeasureTicks: 3600 };

/** A clock that only moves when a test moves it: `step` ms at every progress report except the closing one. */
function fakeClock(step: number) {
  const clock = { t: 0, step };
  return {
    clock,
    now: () => clock.t,
    onProgress: (p: SolveProgress, also?: (p: SolveProgress) => void) => {
      also?.(p);
      if (p.phase !== 'done') clock.t += step;
    },
  };
}

interface Run {
  result: SolveResult;
  improved: { layout: Layout; report: ValidationReport; footprint: number; at: number }[];
  progress: SolveProgress[];
  clock: { t: number };
}

function run(plan: ProductionPlan, over: Partial<SolveOptions>, step: number, shouldStop: (run: Run) => boolean = () => false): Run {
  const fake = fakeClock(step);
  const out: Run = { result: undefined as unknown as SolveResult, improved: [], progress: [], clock: fake.clock };
  const opts: SolveOptions = { ...DEFAULT_SOLVE_OPTIONS, ...SIM, seed: 7, ...over, now: fake.now };
  out.result = solve(
    plan,
    data,
    effects,
    opts,
    (p) => fake.onProgress(p, (q) => out.progress.push(q)),
    (layout, report, footprint) => out.improved.push({ layout, report, footprint, at: fake.clock.t }),
    () => shouldStop(out),
  );
  return out;
}

const messages = (r: ValidationReport): string[] => r.violations.map((v) => `${v.code}: ${v.message}`);

describe('footprintOf', () => {
  it('is 0 for an empty layout', () => {
    expect(footprintOf({ ...compositeLayout().kit.layout(), buildings: [], belts: [], sorters: [] }, data)).toBe(0);
  });

  it('is the bounding box of the buildings: one assembler is its own footprint squared', () => {
    const kit = new LayoutKit(data, effects);
    const asm = kit.assembler(40, -7);
    const fp = occupancyOf([asm]).footprintOf(asm.itemId, 0);
    expect(footprintOf(kit.layout(), data)).toBeCloseTo((fp.maxX - fp.minX) * (fp.maxY - fp.minY), 9);
  });

  it('grows with a belt node, a sorter end and a pole outside the buildings', () => {
    const kit = new LayoutKit(data, effects);
    const asm = kit.assembler(0, 0);
    const fp = occupancyOf([asm]).footprintOf(asm.itemId, 0);
    const w = fp.maxX - fp.minX;
    const h = fp.maxY - fp.minY;
    const base = footprintOf(kit.layout(), data);
    expect(base).toBeCloseTo(w * h, 9);

    kit.belt(1, 1001, [[fp.maxX + 10, 0], [fp.maxX + 10, 1]]);
    expect(footprintOf(kit.layout(), data)).toBeCloseTo((10 + w) * h, 9);

    kit.tesla(0, Math.ceil(fp.maxY) + 20);
    const withPole = footprintOf(kit.layout(), data);
    expect(withPole).toBeGreaterThan(base);
    // the pole's own box reaches above its origin: the box is at least as tall as origin-to-bottom
    expect(withPole).toBeGreaterThanOrEqual((10 + w) * (Math.ceil(fp.maxY) + 20 - fp.minY));
  });

  it('counts a turned building by its turned box', () => {
    for (const yaw of [0, 90] as const) {
      const kit = new LayoutKit(data, effects);
      const plant = kit.building(2204, 0, 0, yaw); // 3.8 by 6.1 tiles
      kit.belt(1, 1001, [[20, 0], [21, 0]]);
      const fp = occupancyOf([plant]).footprintOf(plant.itemId, yaw);
      expect(footprintOf(kit.layout(), data)).toBeCloseTo((21 - fp.minX) * (fp.maxY - fp.minY), 9);
    }
  });
});

describe('annealStart (carry: annealPlacement throws on an initial placement that collides at its margin)', () => {
  const placement = (tag: number) => ({ buildings: [] as PlacedBuilding[], cost: tag });

  it('anneals from the best placement only when it was made at a margin of at least the new one', () => {
    const constructive = vi.fn((m: number) => placement(100 + m));
    const best = { placement: placement(1), margin: 3 };
    expect(annealStart(best, 2, constructive)).toEqual({ placement: best.placement, margin: 2 });
    expect(annealStart(best, 3, constructive)).toEqual({ placement: best.placement, margin: 3 });
    expect(constructive).not.toHaveBeenCalled();
  });

  it('starts from a constructive placement at the new margin when the best was made at a smaller margin', () => {
    const constructive = vi.fn((m: number) => placement(100 + m));
    const best = { placement: placement(1), margin: 1 };
    expect(annealStart(best, 2, constructive)).toEqual({ placement: placement(102), margin: 2 });
    expect(constructive).toHaveBeenCalledWith(2);
  });

  it('starts from a constructive placement when there is no best yet', () => {
    expect(annealStart(null, 1, (m) => placement(m))).toEqual({ placement: placement(1), margin: 1 });
  });
});

describe('validateWithRetry (a longer measure window for a near miss)', () => {
  const layout: Layout = { ...compositeLayout().kit.layout(), meta: { ...compositeLayout().kit.layout().meta, planTargetRate: 2 } };
  const plan = {} as ProductionPlan;
  const CAP = MAX_WARMUP_TICKS;
  /** A simulation result; the warm-up it used defaults to the adaptive cap. */
  const sim = (rate: number, seconds = 60, warmupTicksUsed = CAP, deadlocked = false): SimResult =>
    ({ measuredTargetRate: rate, measureSeconds: seconds, warmupTicksUsed, deadlocked }) as SimResult;
  const report = (violations: ValidationReport['violations'], s: SimResult): ValidationReport => ({
    pass: violations.length === 0,
    violations,
    sim: s,
    checkedAt: '',
    stage: 'simulation',
  });
  const low = { code: 'SIM_OUTPUT_LOW' as const, entities: [], message: 'low' };
  const stalled = { code: 'SIM_STALLED' as const, entities: [], message: 'stalled' };

  function validator(...reports: ValidationReport[]) {
    const calls: ValidateOptions[] = [];
    const fn = vi.fn((_l: Layout, _p: ProductionPlan, _d: unknown, _e: unknown, o: ValidateOptions = {}) => {
      calls.push(o);
      return reports[Math.min(calls.length, reports.length) - 1];
    });
    return { fn: fn as unknown as typeof validateLayout, calls };
  }
  const retry = (v: ReturnType<typeof validator>, settings: Parameters<typeof validateWithRetry>[4] = { simulate: true }) =>
    validateWithRetry(layout, plan, data, effects, settings, v.fn);

  describe('quantum-like plans oscillate by about 2 % per 60 s window', () => {
    it('measures again over a window twice as long when the output falls short by under 2 %', () => {
      const second = report([], sim(1.99, 120));
      const v = validator(report([low], sim(1.97)), second);
      expect(retry(v, { simulate: true, warmupTicks: 900, measureTicks: 3600 })).toBe(second);
      expect(v.calls).toEqual([
        { simulate: true, warmupTicks: 900, measureTicks: 3600 },
        { simulate: true, warmupTicks: 900, measureTicks: 7200 },
      ]);
    });

    it('doubles the window the first run measured when none was given, and leaves the warm-up adaptive', () => {
      const v = validator(report([low], sim(1.97, 300)), report([], sim(2, 600)));
      retry(v);
      expect(v.calls[1].measureTicks).toBe(36000);
      expect(v.calls[1].warmupTicks).toBeUndefined();
    });

    it('returns the longer window verdict even when it fails too (and does not retry again)', () => {
      const second = report([low], sim(1.96, 120));
      const v = validator(report([low], sim(1.97)), second);
      expect(retry(v)).toBe(second);
      expect(v.calls).toHaveLength(2);
    });

    it('does not lengthen the window for a shortfall of 2 % or more, or one with other violations', () => {
      for (const first of [report([low], sim(1.9)), report([low, stalled], sim(1.99)), report([stalled], sim(1.99))]) {
        const v = validator(first);
        expect(retry(v)).toBe(first);
        expect(v.calls).toHaveLength(1);
      }
    });
  });

  it('leaves the warm-up as it was in the second run, adaptive or fixed, and never retries a shortfall of 2 % or more', () => {
    // an adaptive warm-up that ended before its cap is the validator's business now (it stops only on the provisioned rate)
    const first = report([low, stalled], sim(1.5, 300, 10_800));
    const v = validator(first);
    expect(retry(v)).toBe(first);
    expect(v.calls).toHaveLength(1);
  });

  it('does not retry a deadlock', () => {
    const first = report([{ code: 'SIM_DEADLOCK', entities: [], message: 'stuck' }, low], sim(0, 300, 7_200, true));
    const v = validator(first);
    expect(retry(v)).toBe(first);
    expect(v.calls).toHaveLength(1);
  });

  it('does not retry a pass, a static failure or a run without a simulation', () => {
    for (const first of [
      report([], sim(2)),
      { pass: false, violations: [{ code: 'BELT_OVERLAP' as const, entities: [], message: 'x' }], checkedAt: '', stage: 'geometry' as const },
      { pass: true, violations: [], checkedAt: '', stage: 'capacity' as const },
    ]) {
      const v = validator(first);
      expect(retry(v)).toBe(first);
      expect(v.calls).toHaveLength(1);
    }
  });
});

describe('solve', () => {
  it('finds a layout that passes the full validator in the fallback ladder, then improves it', async () => {
    const plan = await ingotPlan();
    const r = run(plan, { timeBudgetMs: 20_000, minRunMs: 1e9 }, 1500);
    expect(r.result.layout).not.toBeNull();
    expect(r.improved.length).toBeGreaterThanOrEqual(1);
    for (const imp of r.improved) {
      expect(messages(imp.report)).toEqual([]);
      expect(imp.report.pass).toBe(true);
      expect(imp.report.stage).toBe('simulation');
      expect(imp.footprint).toBeCloseTo(footprintOf(imp.layout, data), 9);
      // an independent validation of the emitted layout on the same windows
      const again = validateLayout(imp.layout, plan, data, effects, { warmupTicks: SIM.simWarmupTicks, measureTicks: SIM.simMeasureTicks });
      expect(messages(again)).toEqual([]);
    }
    // each emission is a strict improvement
    r.improved.forEach((imp, i) => {
      if (i > 0) expect(imp.footprint).toBeLessThan(r.improved[i - 1].footprint);
    });
    // the result is the last emission
    const last = r.improved[r.improved.length - 1];
    expect(r.result.layout).toBe(last.layout);
    expect(r.result.report).toBe(last.report);
    expect(r.result.footprint).toBe(last.footprint);
    expect(r.result.validated).toBeGreaterThanOrEqual(r.improved.length);
    expect(r.result.attempts).toBeGreaterThanOrEqual(r.result.validated);
    expect(r.result.failures.filter((f) => /internal error/.test(f))).toEqual([]);
    process.stdout.write(
      `solve ingots: ${r.improved.length} improvements ${r.improved.map((i) => i.footprint.toFixed(0)).join(' > ')}; ` +
        `${r.result.attempts} attempts, ${r.result.validated} validated\n`,
    );
  }, 120_000);

  it('stops early when nothing improved in the last 20 % of the elapsed time, once 30 s have passed', async () => {
    const step = 5_000;
    const r = run(await ingotPlan(), { timeBudgetMs: 600_000, minRunMs: 30_000, earlyStopFraction: 0.2 }, step);
    expect(r.result.stoppedBy).toBe('early');
    const T = r.clock.t; // when the stop was decided
    const lastImproved = r.improved[r.improved.length - 1].at;
    expect(T).toBeGreaterThanOrEqual(30_000);
    expect(T - lastImproved).toBeGreaterThanOrEqual(0.2 * T);
    // and it had not been decided at the check before
    const before = T - step;
    expect(before >= 30_000 && before - lastImproved >= 0.2 * before).toBe(false);
    expect(T).toBeLessThan(600_000);
  }, 120_000);

  it('does not stop early before minRunMs, however long ago the last improvement was', async () => {
    const r = run(await ingotPlan(), { timeBudgetMs: 60_000, minRunMs: 50_000, earlyStopFraction: 0.01 }, 4_000);
    expect(r.result.stoppedBy).toBe('early');
    expect(r.clock.t).toBeGreaterThanOrEqual(50_000);
  }, 120_000);

  it('stops when the time budget is used up', async () => {
    const step = 2_500;
    const r = run(await ingotPlan(), { timeBudgetMs: 20_000, minRunMs: 1e9 }, step);
    expect(r.result.stoppedBy).toBe('budget');
    expect(r.clock.t).toBeGreaterThanOrEqual(20_000);
    expect(r.clock.t - step).toBeLessThan(20_000);
    expect(r.result.layout).not.toBeNull();
  }, 120_000);

  it('runs the fallback ladder to completion whatever the budget', async () => {
    const r = run(await ingotPlan(), { timeBudgetMs: 1, minRunMs: 1e9 }, 10_000);
    expect(r.result.stoppedBy).toBe('budget');
    expect(r.result.layout).not.toBeNull();
    expect(r.result.report!.pass).toBe(true);
    expect(r.improved).toHaveLength(1);
    expect(r.result.attempts).toBe(1); // margin 3 routed and validated; no improvement iteration ran
  }, 120_000);

  it('returns the best found when the user stops', async () => {
    const r = run(await ingotPlan(), { timeBudgetMs: 600_000, minRunMs: 1e9 }, 1_000, (x) => x.improved.length >= 1 && x.progress.length >= 5);
    expect(r.result.stoppedBy).toBe('user');
    expect(r.result.layout).toBe(r.improved[r.improved.length - 1].layout);
    expect(r.result.report!.pass).toBe(true);
    expect(r.result.footprint).toBe(r.improved[r.improved.length - 1].footprint);
  }, 120_000);

  it('stops at once, with no layout, when the user stops before anything was found', async () => {
    const r = run(await ingotPlan(), {}, 1_000, () => true);
    expect(r.result).toMatchObject({ layout: null, report: null, footprint: null, attempts: 0, stoppedBy: 'user' });
    expect(r.improved).toHaveLength(0);
  }, 120_000);

  it('reports why every margin failed, and ends exhausted', async () => {
    // no power node unlocked: every rung fails at the power step
    const noPoles = { ...effects, availableBuildings: new Set([...effects.availableBuildings].filter((i) => ![2201, 2202, 2212].includes(i))) };
    const fake = fakeClock(1_000);
    const improved = vi.fn();
    const result = solve(await ingotPlan(), data, noPoles, { ...DEFAULT_SOLVE_OPTIONS, ...SIM, now: fake.now }, (p) => fake.onProgress(p), improved, () => false);
    expect(result.layout).toBeNull();
    expect(result.report).toBeNull();
    expect(result.stoppedBy).toBe('exhausted');
    expect(result.attempts).toBe(3);
    expect(improved).not.toHaveBeenCalled();
    for (const margin of [3, 4, 6]) expect(result.failures.some((f) => f.startsWith(`margin ${margin}: `) && /power/.test(f))).toBe(true);
  }, 120_000);

  /** A validator that answers `verdicts[n]` to the n-th full validation (the real one when that is undefined). */
  function scripted(verdicts: (ValidationReport | Error | undefined)[]) {
    let calls = 0;
    const fn = ((layout, plan, d, fx, o) => {
      const verdict = verdicts[calls++];
      if (verdict instanceof Error) throw verdict;
      return verdict ?? validateLayout(layout, plan, d, fx, o);
    }) as typeof validateLayout;
    return { fn, calls: () => calls };
  }
  const rejection: ValidationReport = {
    pass: false,
    violations: [{ code: 'SIM_STALLED', entities: [], message: 'made up' }],
    checkedAt: '',
    stage: 'simulation',
  };

  it('runs the fallback ladder across its rungs whatever the budget: rung 1 fails, rung 2 is still built and simulated', async () => {
    const v = scripted([rejection]);
    const fake = fakeClock(60_000);
    const improved = vi.fn();
    const result = solve(
      await ingotPlan(), data, effects,
      { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, minRunMs: 1e9, now: fake.now },
      (p) => fake.onProgress(p), improved, () => false, v.fn,
    );
    expect(result.stoppedBy).toBe('budget');
    expect(result.attempts).toBe(2);
    expect(result.layout).not.toBeNull();
    expect(result.report!.pass).toBe(true);
    expect(result.failures).toEqual(['margin 3: SIM_STALLED: made up']);
    expect(improved).toHaveBeenCalledTimes(1);
    expect(v.calls()).toBe(2);
  }, 120_000);

  it('records a validator that throws as a failure of that candidate: in the ladder the next rung goes on', async () => {
    const v = scripted([new Error('boom')]);
    const fake = fakeClock(60_000);
    const result = solve(
      await ingotPlan(), data, effects,
      { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, minRunMs: 1e9, now: fake.now },
      (p) => fake.onProgress(p), () => {}, () => false, v.fn,
    );
    expect(result.layout).not.toBeNull();
    expect(result.attempts).toBe(2);
    expect(result.failures).toEqual(['margin 3: internal error: boom']);
  }, 120_000);

  it('records a validator that throws in the improvement loop once, keeps the best so far and goes on', async () => {
    // the first full validation passes (the ladder's); every later one throws
    const v = scripted([undefined, ...Array.from({ length: 200 }, () => new Error('simulator blew up'))]);
    const fake = fakeClock(1_000);
    const improved: number[] = [];
    const result = solve(
      await ingotPlan(), data, effects,
      { ...DEFAULT_SOLVE_OPTIONS, ...SIM, seed: 7, timeBudgetMs: 12_000, minRunMs: 1e9, now: fake.now },
      (p) => fake.onProgress(p), (_l, _r, f) => improved.push(f), () => false, v.fn,
    );
    expect(result.stoppedBy).toBe('budget');
    expect(improved).toHaveLength(1); // the ladder's layout
    expect(result.layout).not.toBeNull();
    expect(result.footprint).toBe(improved[0]);
    expect(result.failures).toHaveLength(1); // once, though several candidates reached the validator
    expect(result.failures[0]).toMatch(/^margin [12]: internal error: simulator blew up$/);
    expect(v.calls()).toBeGreaterThan(2);
  }, 120_000);

  it('a plain Processor/s plan on default facilities (a slow chain) is accepted only if plain validateLayout accepts it', async () => {
    // Mk.I assemblers, Re-composing Assemblers and Negentropy Smelters: the chain fills over 10 game minutes. The
    // adaptive warm-up used to stop on a plateau at 0.86 of the rate, and a longer warm-up in the solver accepted what
    // validateLayout rejected.
    const plan = await planFor({
      targetItemId: 1303,
      finalFacilityItemId: ASSEMBLER,
      suppliedItemIds: new Set([1001, 1002, 1003]),
    });
    const result = solve(plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1 }, () => {}, () => {}, () => false);
    expect(result.failures).toEqual([]);
    expect(result.layout).not.toBeNull();
    const plain = validateLayout(result.layout!, plan, data, effects);
    expect(messages(plain)).toEqual([]);
    expect(plain.pass).toBe(true);
    expect(plain.sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99);
    expect(result.report!.sim!.warmupTicksUsed).toBeGreaterThan(14_400); // the ramp took more than the plateau at 0.86
  }, 120_000);

  it('does not simulate when simulate is false', async () => {
    const r = run(await ingotPlan(), { simulate: false, timeBudgetMs: 5_000, minRunMs: 1e9 }, 1_000);
    expect(r.result.layout).not.toBeNull();
    expect(r.result.report!.pass).toBe(true);
    expect(r.result.report!.sim).toBeUndefined();
  }, 120_000);

  it('is deterministic for a fixed seed and an injected clock', async () => {
    const plan = await ingotPlan();
    const a = run(plan, { timeBudgetMs: 15_000, minRunMs: 1e9, seed: 11 }, 1_500);
    const b = run(plan, { timeBudgetMs: 15_000, minRunMs: 1e9, seed: 11 }, 1_500);
    const key = (r: Run) => ({
      improved: r.improved.map((i) => ({ layout: i.layout, footprint: i.footprint, at: i.at })),
      progress: r.progress,
      result: { ...r.result, report: undefined },
    });
    expect(key(a)).toEqual(key(b));
    expect(a.result.layout).toEqual(b.result.layout);
  }, 180_000);

  it('solveSteps yields between candidates (a worker reads its messages there) and returns what solve does', async () => {
    const plan = await ingotPlan();
    const fake = fakeClock(1_000);
    const opts: SolveOptions = { ...DEFAULT_SOLVE_OPTIONS, ...SIM, seed: 7, timeBudgetMs: 6_000, minRunMs: 1e9, now: fake.now };
    const reports: SolveProgress[] = [];
    const steps = solveSteps(plan, data, effects, opts, (p) => fake.onProgress(p, (q) => reports.push(q)), () => {}, () => false);
    let yields = 0;
    let next = steps.next();
    while (!next.done) {
      yields++;
      next = steps.next();
    }
    // one yield before each candidate: the ladder's first, then every improvement iteration
    expect(yields).toBe(reports.filter((p) => p.phase !== 'done' && p.phase !== 'start').length + 1);
    expect(next.value.stoppedBy).toBe('budget');
    expect(next.value.layout).not.toBeNull();
  }, 120_000);

  it('reports progress: elapsed time, attempts, the best footprint so far, a phase', async () => {
    const r = run(await ingotPlan(), { timeBudgetMs: 8_000, minRunMs: 1e9 }, 2_000);
    expect(r.progress.length).toBeGreaterThanOrEqual(3);
    expect(r.progress[0]).toMatchObject({ elapsedMs: 0, attempts: 0, validated: 0, bestFootprint: null });
    expect(r.progress[r.progress.length - 1].phase).toBe('done');
    let prev = 0;
    for (const p of r.progress) {
      expect(p.elapsedMs).toBeGreaterThanOrEqual(prev);
      prev = p.elapsedMs;
      expect(typeof p.phase).toBe('string');
    }
    const ends = r.progress.filter((p) => p.bestFootprint !== null).map((p) => p.bestFootprint as number);
    expect(ends.length).toBeGreaterThan(0);
    ends.forEach((f, i) => {
      if (i > 0) expect(f).toBeLessThanOrEqual(ends[i - 1]);
    });
  }, 120_000);
});
