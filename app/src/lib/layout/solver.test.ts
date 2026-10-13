import { describe, expect, it, vi } from 'vitest';
import { compatibleFacilities, plannableProducers, surplusExportsIn } from '../calc';
import type { ProductionPlan } from '../calc';
import type { Layout, PlacedBuilding } from '../geometry';
import { LayoutKit, compositeLayout } from '../validate/testkit';
import { MAX_WARMUP_TICKS, SimulationAborted, validateLayout, WarmupNotSettled } from '../validate';
import type { ValidateOptions, ValidationReport } from '../validate';
import type { SimResult } from '../validate/sim/run';
import { annealHeat, annealStart, BestKeeper, DEADLOCK_PROBE_TICKS, DEFAULT_SOLVE_OPTIONS, footprintOf, ladderRungs, MarginPicker, mayReplaceBest, Reheat, solve, solveSteps, validateGated, validateWithRetry, warmupCapFor } from './solver';
import type { SolveOptions, SolveProgress, SolveResult } from './solver';
import { VERIFIED_MOTIFS } from './motifs';
import { buildNetlist } from './netlist';
import { ASSEMBLER, data, effects, matrixPlan, occupancyOf, planFor, processorPlan, SMELTER } from './testkit';

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

/** A report whose only violation is SIM_OUTPUT_LOW, short by under 2 % of the 3/s of the ingot plan: a near miss. */
const nearMiss = (rate = 2.95): ValidationReport => ({
  pass: false,
  violations: [{ code: 'SIM_OUTPUT_LOW', entities: [], message: 'low' }],
  sim: { measuredTargetRate: rate, measureSeconds: 300, warmupTicksUsed: 7200, deadlocked: false } as SimResult,
  checkedAt: '',
  stage: 'simulation',
});
/** What the doubled measure window of a near miss answers when it passes. */
const longerWindowPass: ValidationReport = {
  pass: true,
  violations: [],
  sim: { measuredTargetRate: 3, measureSeconds: 600, warmupTicksUsed: 7200, deadlocked: false } as SimResult,
  checkedAt: '',
  stage: 'simulation',
};

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

describe('BestKeeper (the smallest layout found, and when it last got smaller: the early stop counts from there)', () => {
  it('takes the first layout, and a smaller one, and records when', () => {
    const keeper = new BestKeeper<{ footprint: number }>();
    expect(keeper.best).toBeNull();
    expect(keeper.improvedAt).toBe(0);
    const first = { footprint: 100 };
    expect(keeper.offer(first, 5)).toBe(true);
    expect([keeper.best, keeper.improvedAt]).toEqual([first, 5]);
    const smaller = { footprint: 80 };
    expect(keeper.offer(smaller, 12)).toBe(true);
    expect([keeper.best, keeper.improvedAt]).toEqual([smaller, 12]);
  });

  it('a layout that is not smaller changes nothing, the time of the last improvement above all', () => {
    const keeper = new BestKeeper<{ footprint: number }>();
    const best = { footprint: 100 };
    keeper.offer(best, 5);
    expect(keeper.offer({ footprint: 120 }, 9)).toBe(false);
    expect(keeper.offer({ footprint: 100 }, 10)).toBe(false);
    expect(keeper.offer({ footprint: 100 - 1e-12 }, 11)).toBe(false); // not smaller by more than float noise
    expect([keeper.best, keeper.improvedAt]).toEqual([best, 5]);
  });
});

describe('MarginPicker (the improvement margin follows the record of what got built)', () => {
  it('gives every margin the same share until it has a record', () => {
    expect(new MarginPicker([1, 2]).shares()).toEqual([0.5, 0.5]);
    const three = new MarginPicker([1, 2, 3]).shares();
    for (const share of three) expect(share).toBeCloseTo(1 / 3, 9);
  });

  it('moves the share to the margin that gets built, and back when the record changes', () => {
    const picker = new MarginPicker([1, 2]);
    for (let i = 0; i < 6; i++) picker.record(1, false);
    for (let i = 0; i < 6; i++) picker.record(2, true);
    const [one, two] = picker.shares();
    expect(one).toBeLessThan(0.2);
    expect(two).toBeGreaterThan(0.8);
    expect(one + two).toBeCloseTo(1, 9);
    for (let i = 0; i < 40; i++) picker.record(1, true);
    expect(picker.shares()[0]).toBeGreaterThan(0.4);
  });

  it('never takes a margin below its minimum share, however badly it did', () => {
    const picker = new MarginPicker([1, 2]);
    for (let i = 0; i < 500; i++) {
      picker.record(1, false);
      picker.record(2, true);
    }
    expect(picker.shares()[0]).toBeCloseTo(0.15, 9);
    const picks = Array.from({ length: 1000 }, (_, i) => picker.pick((i + 0.5) / 1000));
    expect(picks.filter((m) => m === 1)).toHaveLength(150);
  });

  it('picks by the draw: the first margin below its share, the next above', () => {
    const picker = new MarginPicker([1, 2]);
    expect(picker.pick(0)).toBe(1);
    expect(picker.pick(0.49)).toBe(1);
    expect(picker.pick(0.5)).toBe(2);
    expect(picker.pick(0.999)).toBe(2);
  });

  it('ignores a margin it does not know', () => {
    const picker = new MarginPicker([1, 2]);
    picker.record(5, true);
    expect(picker.shares()).toEqual([0.5, 0.5]);
  });
});

describe('Reheat (the anneal starts hotter the longer the best layout has stood)', () => {
  it('starts at the base temperature', () => {
    expect(new Reheat().heat()).toBe(1);
  });

  it('rises by a quarter of the base temperature for every iteration that found nothing better, to 8 times', () => {
    const reheat = new Reheat();
    const seen: number[] = [];
    for (let i = 0; i < 32; i++) {
      reheat.iteration();
      seen.push(reheat.heat());
    }
    expect(seen.slice(0, 4)).toEqual([1.25, 1.5, 1.75, 2]);
    expect(seen[27]).toBe(8); // 28 stale iterations
    expect(seen[31]).toBe(8);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('goes back to the base temperature when the best layout gets smaller', () => {
    const reheat = new Reheat();
    for (let i = 0; i < 10; i++) reheat.iteration();
    expect(reheat.heat()).toBe(3.5);
    reheat.improved();
    expect(reheat.heat()).toBe(1);
  });
});

describe('annealHeat (only an anneal that could use more moves than it gets in the cap is reheated)', () => {
  const stale = (iterations: number): Reheat => {
    const reheat = new Reheat();
    for (let i = 0; i < iterations; i++) reheat.iteration();
    return reheat;
  };

  it('is the reheat factor when the time would allow the cap or more', () => {
    expect(annealHeat(stale(8), 400_000, 380_000)).toBe(3);
    expect(annealHeat(stale(8), 380_000, 380_000)).toBe(3);
  });

  it('is 1 when the time allows fewer moves than the cap: such an anneal needs all its moves to cool down', () => {
    expect(annealHeat(stale(8), 2_000_000, 4_620_000)).toBe(1);
    expect(annealHeat(stale(40), 379_999, 380_000)).toBe(1);
  });
});

describe('mayReplaceBest (a layout that passes only over the doubled window never replaces one that passes the plain window)', () => {
  const plain = { longerWindow: false };
  const doubled = { longerWindow: true };

  it('lets a plain pass replace anything, and anything fill an empty place', () => {
    expect(mayReplaceBest(plain, plain)).toBe(true);
    expect(mayReplaceBest(doubled, plain)).toBe(true);
    expect(mayReplaceBest(null, plain)).toBe(true);
    expect(mayReplaceBest(null, doubled)).toBe(true);
  });

  it('lets a doubled-window pass replace only a doubled-window pass', () => {
    expect(mayReplaceBest(doubled, doubled)).toBe(true);
    expect(mayReplaceBest(plain, doubled)).toBe(false);
  });
});

describe('warmupCapFor (how long the improvement loop waits for a candidate to reach its rate)', () => {
  const reportWith = (warmupTicksUsed: number | undefined): ValidationReport =>
    ({ pass: true, violations: [], checkedAt: '', stage: 'simulation', sim: warmupTicksUsed === undefined ? undefined : ({ warmupTicksUsed } as SimResult) }) as ValidationReport;

  it('is twice the warm-up of the best layout when that is a saving of at least half the adaptive limit', () => {
    expect(warmupCapFor(reportWith(10_800))).toBe(21_600);
    expect(warmupCapFor(reportWith(18_000))).toBe(36_000);
  });

  it('leaves a quick layout four windows to fill', () => {
    expect(warmupCapFor(reportWith(3_600))).toBe(14_400);
    expect(warmupCapFor(reportWith(7_200))).toBe(14_400);
  });

  it('is no cap for a layout that needed more than a quarter of the limit: twice that saves too little and turns away candidates that pass at the limit', () => {
    expect(warmupCapFor(reportWith(18_001))).toBeUndefined();
    expect(warmupCapFor(reportWith(25_200))).toBeUndefined();
    expect(warmupCapFor(reportWith(32_400))).toBeUndefined();
    expect(warmupCapFor(reportWith(50_000))).toBeUndefined();
    expect(warmupCapFor(reportWith(MAX_WARMUP_TICKS))).toBeUndefined();
  });

  it('is none when the best layout was not simulated', () => {
    expect(warmupCapFor(reportWith(undefined))).toBeUndefined();
    expect(warmupCapFor(null)).toBeUndefined();
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

    it('doubles the window the first run\'s verdict stood on, so a retry never overrides a long window with a shorter one (first-miss rule, final review item 2)', () => {
      // the first run waited out a first miss and measured its verdict over four windows (1200 s): the retry is 2400 s, not 600 s
      const v = validator(report([low], sim(1.98, 1200)), report([], sim(2, 2400)));
      retry(v);
      expect(v.calls[1].measureTicks).toBe(144000);
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

describe('ladderRungs (what the fallback ladder tries, in this order)', () => {
  it('is margins 3, 4 and 6 with the fast router, and then the same three with the exact router', () => {
    expect(ladderRungs()).toEqual([
      { margin: 3, exact: false },
      { margin: 4, exact: false },
      { margin: 6, exact: false },
      { margin: 3, exact: true },
      { margin: 4, exact: true },
      { margin: 6, exact: true },
    ]);
  });
});

describe('validateGated (validateWithRetry, saying whether the longer window decided)', () => {
  const layout: Layout = { ...compositeLayout().kit.layout(), meta: { ...compositeLayout().kit.layout().meta, planTargetRate: 2 } };
  const plan = {} as ProductionPlan;
  const sim = (rate: number, seconds = 300): SimResult => ({ measuredTargetRate: rate, measureSeconds: seconds, warmupTicksUsed: 7200, deadlocked: false }) as SimResult;
  const report = (violations: ValidationReport['violations'], s: SimResult): ValidationReport => ({ pass: violations.length === 0, violations, sim: s, checkedAt: '', stage: 'simulation' });
  const low = { code: 'SIM_OUTPUT_LOW' as const, entities: [], message: 'low' };
  const answers = (...reports: ValidationReport[]) => {
    let n = 0;
    return (() => reports[Math.min(n++, reports.length - 1)]) as unknown as typeof validateLayout;
  };

  it('says no for a layout that passes the plain window', () => {
    const first = report([], sim(2));
    expect(validateGated(layout, plan, data, effects, { simulate: true }, answers(first))).toEqual({ report: first, longerWindow: false });
  });

  it('says yes for a layout that passes only over the doubled window', () => {
    const second = report([], sim(2, 600));
    const gated = validateGated(layout, plan, data, effects, { simulate: true }, answers(report([low], sim(1.97)), second));
    expect(gated.report).toBe(second);
    expect(gated.longerWindow).toBe(true);
  });

  it('says yes when the doubled window decided against the layout too, and no for a shortfall that is not a near miss', () => {
    const second = report([low], sim(1.96, 600));
    const gated = validateGated(layout, plan, data, effects, { simulate: true }, answers(report([low], sim(1.97)), second));
    expect(gated.report).toBe(second);
    expect(gated.longerWindow).toBe(true);
    const far = report([low], sim(1.5));
    expect(validateGated(layout, plan, data, effects, { simulate: true }, answers(far))).toEqual({ report: far, longerWindow: false });
  });

  it('with nearMissRetry off a near miss is not validated again: the first verdict stands, and the validator is asked once', () => {
    const near = report([low], sim(1.97));
    let calls = 0;
    const once = ((): ValidationReport => (calls++, near)) as unknown as typeof validateLayout;
    expect(validateGated(layout, plan, data, effects, { simulate: true, nearMissRetry: false }, once)).toEqual({ report: near, longerWindow: false });
    expect(calls).toBe(1);
    // on by default and when set: the doubled window runs
    calls = 0;
    const twice = ((): ValidationReport => (calls++, calls === 1 ? near : report([], sim(2, 600)))) as unknown as typeof validateLayout;
    expect(validateGated(layout, plan, data, effects, { simulate: true, nearMissRetry: true }, twice).longerWindow).toBe(true);
    expect(calls).toBe(2);
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
    expect(result.attempts).toBe(6); // the fast rungs, then the exact router's
    expect(improved).not.toHaveBeenCalled();
    for (const margin of [3, 4, 6]) expect(result.failures.some((f) => f.startsWith(`margin ${margin}: `) && /power/.test(f))).toBe(true);
    for (const margin of [3, 4, 6]) expect(result.failures.some((f) => f.startsWith(`margin ${margin} (exact routes): `) && /power/.test(f))).toBe(true);
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

  describe('long simulations of candidates (Task 27)', () => {
    /** `scripted`, and the options of every full validation. */
    function watched(verdicts: (ValidationReport | Error | undefined)[]) {
      const seen: ValidateOptions[] = [];
      const inner = scripted(verdicts);
      const fn = ((layout, plan, d, fx, o) => {
        seen.push(o ?? {});
        return inner.fn(layout, plan, d, fx, o);
      }) as typeof validateLayout;
      return { fn, seen };
    }
    const adaptive = { ...DEFAULT_SOLVE_OPTIONS, seed: 7, minRunMs: 1e9 };

    it('validates the ladder without a cap and with an abort for the user, and the improvement candidates with a cap of twice the best warm-up and an abort for the budget', async () => {
      const v = watched([]);
      const fake = fakeClock(1_000);
      const improved: ValidationReport[] = [];
      let stop = false;
      const result = solve(
        await ingotPlan(), data, effects, { ...adaptive, timeBudgetMs: 10_000, now: fake.now },
        (p) => fake.onProgress(p), (_l, r) => improved.push(r), () => stop, v.fn,
      );
      expect(v.seen.length).toBeGreaterThanOrEqual(2);
      expect(v.seen[0].warmupCapTicks).toBeUndefined();
      expect(v.seen[0].shouldAbort).toBeTypeOf('function');
      // the ladder's abort is the user's stop, not the budget
      stop = true;
      expect(v.seen[0].shouldAbort!()).toBe(true);
      stop = false;
      expect(v.seen[0].shouldAbort!()).toBe(false);
      // the cap of an improvement candidate is twice the warm-up of the best layout when it was validated
      const best = improved[0];
      expect(best.sim!.warmupTicksUsed).toBeGreaterThan(0);
      expect(v.seen[1].warmupCapTicks).toBe(warmupCapFor(best));
      expect(v.seen[1].shouldAbort).toBeTypeOf('function');
      // the improvement loop's abort is the budget: the fake clock is past it by now
      expect(v.seen[1].shouldAbort!()).toBe(fake.clock.t >= 10_000);
      expect(result.layout).not.toBeNull();
    }, 120_000);

    it('turns a candidate that does not settle within its cap down like any failed simulation: no internal error, and the loop goes on', async () => {
      const v = watched([undefined, ...Array.from({ length: 200 }, () => new WarmupNotSettled(14_400))]);
      const fake = fakeClock(1_000);
      const phases: string[] = [];
      const result = solve(
        await ingotPlan(), data, effects, { ...adaptive, timeBudgetMs: 12_000, now: fake.now },
        (p) => fake.onProgress(p, (q) => phases.push(q.phase)), () => {}, () => false, v.fn,
      );
      expect(result.stoppedBy).toBe('budget');
      expect(result.failures).toEqual([]);
      expect(v.seen.length).toBeGreaterThan(2);
      expect(phases.some((p) => /^improve: margin \d rejected by the simulation$/.test(p))).toBe(true);
    }, 120_000);

    it('drops a candidate whose simulation was aborted without calling it a failure, and ends on the budget', async () => {
      const v = watched([undefined, ...Array.from({ length: 200 }, () => new SimulationAborted())]);
      const fake = fakeClock(1_000);
      const phases: string[] = [];
      const result = solve(
        await ingotPlan(), data, effects, { ...adaptive, timeBudgetMs: 12_000, now: fake.now },
        (p) => fake.onProgress(p, (q) => phases.push(q.phase)), () => {}, () => false, v.fn,
      );
      expect(result.stoppedBy).toBe('budget');
      expect(result.failures).toEqual([]);
      expect(phases.some((p) => /^improve: margin \d stopped$/.test(p))).toBe(true);
      expect(phases.some((p) => p.includes('rejected'))).toBe(false);
    }, 120_000);

    it('checks the budget inside a long validation: the abort turns yes while the clock runs past it, and the candidate is dropped', async () => {
      const fake = fakeClock(1_000);
      const polled: boolean[] = [];
      let calls = 0;
      const validate = ((layout, p, d, fx, o) => {
        if (++calls === 1) return validateLayout(layout, p, d, fx, o); // the ladder's
        // a simulation that takes ten seconds of the (fake) clock and asks for an abort every second of it
        for (let second = 0; second < 10; second++) {
          fake.clock.t += 1_000;
          const abort = (o as ValidateOptions).shouldAbort!();
          polled.push(abort);
          if (abort) throw new SimulationAborted();
        }
        throw new Error('the abort never came');
      }) as typeof validateLayout;
      const phases: string[] = [];
      const result = solve(
        await ingotPlan(), data, effects, { ...adaptive, timeBudgetMs: 6_000, now: fake.now },
        (p) => fake.onProgress(p, (q) => phases.push(q.phase)), () => {}, () => false, validate,
      );
      expect(result.stoppedBy).toBe('budget');
      expect(result.failures).toEqual([]);
      expect(polled.length).toBeGreaterThan(0);
      expect(polled[polled.length - 1]).toBe(true);
      expect(polled.slice(0, -1).every((a) => !a)).toBe(true);
      // the budget was passed during the validation, not at the next check between candidates: it ran at most 10 s past it
      expect(fake.clock.t).toBeLessThan(6_000 + 11_000);
      expect(phases.some((p) => /^improve: margin \d stopped$/.test(p))).toBe(true);
    }, 120_000);

    it('ends with the user when the ladder\'s simulation is aborted', async () => {
      const v = watched([new SimulationAborted()]);
      const fake = fakeClock(1_000);
      const improved = vi.fn();
      const result = solve(
        await ingotPlan(), data, effects, { ...adaptive, timeBudgetMs: 12_000, now: fake.now },
        (p) => fake.onProgress(p), improved, () => false, v.fn,
      );
      expect(result.stoppedBy).toBe('user');
      expect(result.layout).toBeNull();
      expect(result.failures).toEqual([]);
      expect(result.attempts).toBe(1);
      expect(improved).not.toHaveBeenCalled();
    }, 120_000);

    it('what the improvement loop accepts under a cap passes plain validateLayout too', async () => {
      const plan = await ingotPlan();
      const r = run(plan, { ...adaptive, timeBudgetMs: 12_000, simWarmupTicks: undefined, simMeasureTicks: undefined }, 1_000);
      expect(r.improved.length).toBeGreaterThanOrEqual(1);
      for (const imp of r.improved) {
        const plain = validateLayout(imp.layout, plan, data, effects);
        expect(messages(plain)).toEqual([]);
        expect(plain.pass).toBe(true);
        expect(plain.sim!.warmupTicksUsed).toBe(imp.report.sim!.warmupTicksUsed);
      }
    }, 180_000);
  });

  describe('the fallback ladder (Task 27)', () => {
    const go = async (verdicts: (ValidationReport | Error | undefined)[]) => {
      const v = scripted(verdicts);
      const fake = fakeClock(60_000);
      const phases: string[] = [];
      const result = solve(
        await ingotPlan(), data, effects,
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, minRunMs: 1e9, now: fake.now },
        (p) => fake.onProgress(p, (q) => phases.push(q.phase)), () => {}, () => false, v.fn,
      );
      return { result, phases, calls: v.calls };
    };

    it('goes on to the exact router rungs when the three fast ones fail, and takes the first that passes', async () => {
      const { result, phases } = await go([rejection, rejection, rejection]);
      expect(result.layout).not.toBeNull();
      expect(result.report!.pass).toBe(true);
      expect(result.attempts).toBe(4);
      expect(result.failures).toEqual(['margin 3: SIM_STALLED: made up', 'margin 4: SIM_STALLED: made up', 'margin 6: SIM_STALLED: made up']);
      expect(phases).toContain('ladder: margin 3 (exact routes)');
    }, 120_000);

    it('ends exhausted only after the exact rungs failed as well, naming every rung', async () => {
      const { result } = await go(Array.from({ length: 6 }, () => rejection));
      expect(result.stoppedBy).toBe('exhausted');
      expect(result.layout).toBeNull();
      expect(result.attempts).toBe(6);
      expect(result.failures).toEqual([
        'margin 3: SIM_STALLED: made up',
        'margin 4: SIM_STALLED: made up',
        'margin 6: SIM_STALLED: made up',
        'margin 3 (exact routes): SIM_STALLED: made up',
        'margin 4 (exact routes): SIM_STALLED: made up',
        'margin 6 (exact routes): SIM_STALLED: made up',
      ]);
    }, 120_000);

    it('prefers a layout that passes the plain window to one that passes only over the doubled window, though it is not smaller', async () => {
      // rung 1: near miss, the doubled window passes; rung 2: the real validator, a plain pass
      const { result, calls } = await go([nearMiss(), longerWindowPass, undefined]);
      expect(result.attempts).toBe(2);
      expect(calls()).toBe(3);
      expect(result.report!.sim!.measureSeconds).toBe(SIM.simMeasureTicks / 60); // the real validator's window, not the scripted 600 s
      expect(result.failures).toEqual([]);
    }, 120_000);

    it('falls back to the first layout that passed only over the doubled window when no rung passes the plain one', async () => {
      const { result, phases } = await go([nearMiss(), longerWindowPass, nearMiss(), longerWindowPass, nearMiss(), longerWindowPass]);
      expect(result.attempts).toBe(3); // the three fast rungs; the exact ones are not needed for a layout
      expect(result.layout).not.toBeNull();
      expect(result.report).toBe(longerWindowPass);
      expect(phases).toContain('ladder: margin 3, over the longer window');
      expect(result.failures).toEqual([]);
    }, 120_000);

    describe('the improvement loop does not trade a plain pass for a doubled-window pass', () => {
      /** The ladder's verdicts, then pairs of (near miss, doubled window passes) for as many candidates as the budget allows. */
      const nearMisses = (count: number): ValidationReport[] => Array.from({ length: count }, () => [nearMiss(), longerWindowPass]).flat();
      const loop = async (verdicts: (ValidationReport | Error | undefined)[]) => {
        const v = scripted(verdicts);
        const improved: ValidationReport[] = [];
        const phases: string[] = [];
        const fake = fakeClock(1_000);
        const result = solve(
          await ingotPlan(), data, effects,
          { ...DEFAULT_SOLVE_OPTIONS, ...SIM, seed: 7, timeBudgetMs: 20_000, minRunMs: 1e9, now: fake.now },
          (p) => fake.onProgress(p, (q) => phases.push(q.phase)), (_l, r) => improved.push(r), () => false, v.fn,
        );
        return { result, improved, phases, calls: v.calls };
      };

      it('keeps a plain best when every candidate is a near miss, and runs the doubled window for none of them', async () => {
        // the ladder's answer is the real validator's (a plain pass); every candidate after it is short of the rate by under 2 %
        const { result, improved, phases, calls } = await loop([undefined, ...Array.from({ length: 80 }, () => nearMiss())]);
        const rejected = phases.filter((p) => /^improve: margin \d rejected by the simulation$/.test(p)).length;
        expect(rejected).toBeGreaterThanOrEqual(1);
        // one validator call for the ladder and one per candidate: a near miss that cannot replace a plain best is not simulated again
        expect(calls()).toBe(1 + rejected);
        expect(improved).toHaveLength(1); // the ladder's
        expect(result.report).toBe(improved[0]);
        expect(result.report!.sim!.measureSeconds).toBe(SIM.simMeasureTicks / 60); // a plain window, not the scripted 300 s
        expect(phases.some((p) => /over the longer window only/.test(p))).toBe(false);
        expect(result.failures).toEqual([]);
      }, 120_000);

      it('still runs the doubled window of a near miss when the best is itself a doubled-window pass (it could replace it)', async () => {
        const { calls, improved } = await loop([...nearMisses(3), ...nearMisses(80)]);
        // six calls for the ladder's three rungs (near miss, doubled window) and two for each candidate that was tried
        expect(calls()).toBeGreaterThanOrEqual(8);
        expect(calls() % 2).toBe(0);
        expect(improved.length).toBeGreaterThan(1);
      }, 120_000);

      it('takes candidates that pass only over the doubled window while the best is itself such a pass', async () => {
        const { result, improved, calls } = await loop([...nearMisses(3), ...nearMisses(80)]);
        expect(calls()).toBeGreaterThanOrEqual(8); // six for the ladder, two for a candidate
        expect(improved.length).toBeGreaterThan(1);
        expect(improved.every((r) => r === longerWindowPass)).toBe(true);
        expect(result.report).toBe(longerWindowPass);
      }, 120_000);

      it('lets a plain pass replace a doubled-window best, and then keeps it against doubled-window candidates', async () => {
        // ladder: doubled-window passes on all three fast rungs; first candidate: the real validator (a plain pass); then near misses
        const { result, improved } = await loop([...nearMisses(3), undefined, ...nearMisses(80)]);
        expect(improved.length).toBeGreaterThanOrEqual(2);
        expect(improved[0]).toBe(longerWindowPass);
        expect(improved[1]).not.toBe(longerWindowPass);
        expect(improved[1].sim!.measureSeconds).toBe(SIM.simMeasureTicks / 60);
        expect(improved.slice(1).every((r) => r !== longerWindowPass)).toBe(true);
        expect(result.report).toBe(improved[improved.length - 1]);
      }, 120_000);
    });

    describe('a user stop keeps the layout that passed over the doubled window (it is parked until the rungs end)', () => {
      /** Three fast rungs of near misses that the doubled window passes, with a stop that `stopWhen` decides. */
      const stoppedRun = async (verdicts: (ValidationReport | Error | undefined)[], stopWhen: (calls: () => number) => () => boolean) => {
        const v = scripted(verdicts);
        const improved: ValidationReport[] = [];
        const fake = fakeClock(60_000);
        const result = solve(
          await ingotPlan(), data, effects,
          { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, minRunMs: 1e9, now: fake.now },
          (p) => fake.onProgress(p), (_l, r) => improved.push(r), stopWhen(v.calls), v.fn,
        );
        return { result, improved };
      };
      const keptIt = (r: Awaited<ReturnType<typeof stoppedRun>>): void => {
        expect(r.result.stoppedBy).toBe('user');
        expect(r.result.layout).not.toBeNull();
        expect(r.result.report).toBe(longerWindowPass);
        expect(r.result.footprint).toBeGreaterThan(0);
        expect(r.improved).toEqual([longerWindowPass]);
        expect(r.result.failures).toEqual([]);
      };

      it('between rungs', async () => {
        keptIt(await stoppedRun([nearMiss(), longerWindowPass], (calls) => () => calls() >= 2));
      }, 120_000);

      it('while the next rung is routed', async () => {
        // the check at the top of rung 2 says no, the router's check inside it says yes
        keptIt(await stoppedRun([nearMiss(), longerWindowPass], (calls) => {
          let asks = 0;
          return () => calls() >= 2 && ++asks > 1;
        }));
      }, 120_000);

      it('while the next rung is simulated', async () => {
        keptIt(await stoppedRun([nearMiss(), longerWindowPass, new SimulationAborted()], (calls) => () => calls() >= 3));
      }, 120_000);

      it('with nothing parked, a stop still returns no layout', async () => {
        const control = await stoppedRun([], () => () => false);
        expect(control.result.layout).not.toBeNull();
        const stopped = await stoppedRun([], () => () => true);
        expect(stopped.result.stoppedBy).toBe('user');
        expect(stopped.result.layout).toBeNull();
        expect(stopped.improved).toEqual([]);
      }, 120_000);
    });

    it('emits that layout once, at the end of the ladder', async () => {
      const improved: number[] = [];
      const v = scripted([nearMiss(), longerWindowPass, nearMiss(), longerWindowPass, nearMiss(), longerWindowPass]);
      const fake = fakeClock(60_000);
      solve(
        await ingotPlan(), data, effects,
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, minRunMs: 1e9, now: fake.now },
        (p) => fake.onProgress(p), (_l, _r, f) => improved.push(f), () => false, v.fn,
      );
      expect(improved).toHaveLength(1);
    }, 120_000);
  });

  describe('the ladder\'s own budget (Task 30b): a plan the router cannot do must not run for hours', () => {
    /** No power node is unlocked, so every rung of the ladder fails at once, at the power step: a ladder that takes `step` ms a rung. */
    const noPoles = { ...effects, availableBuildings: new Set([...effects.availableBuildings].filter((i) => ![2201, 2202, 2212].includes(i))) };

    it('stops between rungs when its budget is used up: no layout, stoppedBy budget, the rungs it tried, and a failure that says why', async () => {
      const fake = fakeClock(1_000);
      const phases: string[] = [];
      const result = solve(
        await ingotPlan(), data, noPoles,
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, ladderBudgetMs: 2_500, now: fake.now },
        (p) => fake.onProgress(p, (q) => phases.push(q.phase)), () => {}, () => false,
      );
      expect(result.stoppedBy).toBe('budget');
      expect(result.layout).toBeNull();
      expect(result.attempts).toBeLessThan(6);
      expect(result.attempts).toBeGreaterThanOrEqual(1);
      expect(result.failures.at(-1)).toMatch(/^no valid layout within the time budget of 3 s: the ladder tried \d of its 6 rungs/);
      expect(result.failures.filter((f) => /power/.test(f)).length).toBeGreaterThan(0); // the rungs' own reasons are still there
      expect(phases.at(-1)).toBe('done');
    }, 120_000);

    it('without a ladder budget the same ladder tries all six rungs and ends exhausted, as before', async () => {
      const fake = fakeClock(1_000);
      const result = solve(
        await ingotPlan(), data, noPoles,
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, now: fake.now },
        (p) => fake.onProgress(p), () => {}, () => false,
      );
      expect(result.stoppedBy).toBe('exhausted');
      expect(result.attempts).toBe(6);
    }, 120_000);

    it('stops inside a long simulation: the abort the ladder gives its validator turns yes at the budget, and the answer is the budget\'s, not the user\'s', async () => {
      const fake = fakeClock(1_000);
      const aborts: boolean[] = [];
      const validate = ((_layout, _plan, _d, _fx, o) => {
        // a simulation that takes ten seconds of the fake clock and asks for an abort every second of it
        for (let second = 0; second < 10; second++) {
          fake.clock.t += 1_000;
          const abort = (o as ValidateOptions).shouldAbort!();
          aborts.push(abort);
          if (abort) throw new SimulationAborted();
        }
        throw new Error('the simulation was never told to stop');
      }) as typeof validateLayout;
      const result = solve(
        await ingotPlan(), data, effects,
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, ladderBudgetMs: 5_000, now: fake.now },
        (p) => fake.onProgress(p), () => {}, () => false, validate,
      );
      expect(result.stoppedBy).toBe('budget');
      expect(result.layout).toBeNull();
      expect(aborts.indexOf(true)).toBeGreaterThan(0); // it was told no at first, and yes once the clock passed 5 s
      expect(aborts.indexOf(true)).toBeLessThanOrEqual(5);
      expect(result.attempts).toBe(1); // no second rung after the stop
    }, 120_000);

    it('a user stop is still the user\'s, and a layout found inside the budget is the ladder\'s answer as ever', async () => {
      const fake = fakeClock(1_000);
      const stopped = solve(
        await ingotPlan(), data, effects,
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, ladderBudgetMs: 60_000, now: fake.now },
        (p) => fake.onProgress(p), () => {}, () => true,
      );
      expect(stopped.stoppedBy).toBe('user');
      expect(stopped.failures).toEqual([]);
      const clock = fakeClock(1_000);
      const found = solve(
        await ingotPlan(), data, effects,
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, ladderBudgetMs: 60_000, now: clock.now },
        (p) => clock.onProgress(p), () => {}, () => false,
      );
      expect(found.layout).not.toBeNull();
      expect(found.report!.pass).toBe(true);
    }, 120_000);

    it('keeps the layout that passed over the doubled window when the budget ends the ladder (a stop returns what the ladder found)', async () => {
      const fake = fakeClock(1_000);
      const v = scripted([nearMiss(), longerWindowPass]);
      const result = solve(
        await ingotPlan(), data, effects,
        // the first rung (1 s of the fake clock) passes over the doubled window, and the budget is gone before the second begins
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, ladderBudgetMs: 1_500, now: fake.now },
        (p) => fake.onProgress(p), () => {}, () => false, v.fn,
      );
      expect(result.layout).not.toBeNull();
      expect(result.report).toBe(longerWindowPass);
      expect(result.stoppedBy).toBe('budget');
      expect(result.failures.some((f) => /no valid layout within/.test(f))).toBe(false); // there is one
    }, 120_000);
  });

  describe('surplus sinks (Task 30b): the ladder switches them on only when a validation finds a deadlock', () => {
    /** Deuteron Fuel Rod with Mk.III proliferator at 1/s, the default headroom: hydrogen is made by two stages, so it is a candidate. */
    const deuteronPlan = async (): Promise<ProductionPlan> => {
      const item = data.data.items.find((i) => i.name === 'Deuteron Fuel Rod')!;
      const facility = compatibleFacilities(plannableProducers(item.id, data, effects)[0], data).find((b) => effects.availableBuildings.has(b.itemId))!;
      const raw = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1030, 1031];
      return planFor({
        targetItemId: item.id,
        finalFacilityItemId: facility.itemId,
        suppliedItemIds: new Set(raw),
        proliferator: { tier: 3, mode: 'extra' },
        machineHeadroom: undefined,
      });
    };
    const HYDROGEN = data.data.items.find((i) => i.name === 'Hydrogen')!.id;
    const deadlock: ValidationReport = {
      pass: false,
      violations: [
        { code: 'SIM_OUTPUT_LOW', entities: [], message: 'none' },
        { code: 'SIM_DEADLOCK', entities: [], message: 'nothing moved' },
      ],
      checkedAt: '',
      stage: 'simulation',
    };
    const passed: ValidationReport = { pass: true, violations: [], checkedAt: '', stage: 'simulation' };

    /** A validator that answers `verdicts[n]` to the n-th validation and records the plan, the layout and the probe it was given. */
    function recording(verdicts: ValidationReport[]) {
      const seen: { plan: ProductionPlan; layout: Layout; probe: number | undefined }[] = [];
      const fn = ((layout, plan, _d, _fx, o) => {
        seen.push({ plan, layout, probe: (o as ValidateOptions | undefined)?.deadlockProbeTicks });
        return verdicts[Math.min(seen.length - 1, verdicts.length - 1)];
      }) as typeof validateLayout;
      return { fn, seen };
    }
    /** The verdict of a layout that moved in the measurement and was stuck at the probe's horizon: SIM_DEADLOCK alone. */
    const probeDeadlock: ValidationReport = {
      pass: false,
      violations: [{ code: 'SIM_DEADLOCK', entities: [], message: 'the measurement made progress, but at tick 1000000 of the run nothing did' }],
      checkedAt: '',
      stage: 'simulation',
    };
    const hasHydrogenExport = (plan: ProductionPlan): boolean => plan.stationSlots.some((s) => s.itemId === HYDROGEN && s.role === 'export');
    const solveWith = (plan: ProductionPlan, v: typeof validateLayout, phases: string[] = []) => {
      const fake = fakeClock(1);
      return solve(
        plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, now: fake.now },
        (p) => fake.onProgress(p, (q) => phases.push(q.phase)), () => {}, () => false, v,
      );
    };

    it('the plan has the candidate and no slot for it, so the first netlist has no sink', async () => {
      const plan = await deuteronPlan();
      expect(plan.surplus?.map((x) => x.itemId)).toEqual([HYDROGEN]);
      expect(hasHydrogenExport(plan)).toBe(false);
    });

    it('a deadlock on rung 1 switches the sinks on for the retry of that rung and for the rungs after it, and the labels say so', async () => {
      const plan = await deuteronPlan();
      const v = recording([deadlock, rejection, passed]); // rung 1 deadlocks, its retry is turned down, margin 4 passes
      const phases: string[] = [];
      const result = solveWith(plan, v.fn, phases);
      expect(v.seen.length).toBe(3);
      expect(v.seen.map((x) => hasHydrogenExport(x.plan))).toEqual([false, true, true]);
      expect(v.seen.map((x) => surplusExportsIn(x.layout, plan).length)).toEqual([0, 1, 1]); // the layouts have the slot too
      expect(phases.filter((p) => p.startsWith('ladder:'))).toEqual([
        'ladder: margin 3 deadlocked; Hydrogen gets a surplus export from here on',
        'ladder: margin 3 (surplus export) rejected',
        'ladder: margin 4 (surplus export)',
      ]);
      expect(result.layout).not.toBeNull();
      expect(result.report).toBe(passed);
      expect(surplusExportsIn(result.layout!, plan).map((x) => x.itemId)).toEqual([HYDROGEN]);
      expect(result.failures.map((f) => f.split(':')[0])).toEqual(['margin 3', 'margin 3', 'margin 3 (surplus export)']);
    }, 300_000);

    it('the exact rungs after a switch are labelled with both: a ladder that deadlocks first and then fails on every rung', async () => {
      const plan = await deuteronPlan();
      const v = recording([deadlock, rejection]);
      const phases: string[] = [];
      const result = solveWith(plan, v.fn, phases);
      expect(result.layout).toBeNull();
      expect(result.stoppedBy).toBe('exhausted');
      const labels = phases.filter((p) => p.startsWith('ladder:'));
      expect(labels[0]).toBe('ladder: margin 3 deadlocked; Hydrogen gets a surplus export from here on');
      expect(labels.slice(1).every((p) => p.includes('(surplus export)') || p.includes('surplus export)'))).toBe(true);
      expect(labels.some((p) => p.includes('exact routes, surplus export'))).toBe(true);
      expect(v.seen.slice(1).every((x) => hasHydrogenExport(x.plan))).toBe(true);
    }, 300_000);

    it('a ladder with no deadlock never uses the sinks: every layout is built without them, and the labels say nothing of them', async () => {
      const plan = await deuteronPlan();
      const v = recording([rejection]); // every rung that gets as far as the validator is turned down for a stage, not a deadlock
      const phases: string[] = [];
      const result = solveWith(plan, v.fn, phases);
      expect(result.layout).toBeNull();
      expect(result.stoppedBy).toBe('exhausted');
      expect(v.seen.length).toBeGreaterThanOrEqual(2);
      for (const x of v.seen) {
        expect(hasHydrogenExport(x.plan)).toBe(false);
        expect(surplusExportsIn(x.layout, plan)).toEqual([]);
      }
      expect(phases.some((p) => p.includes('surplus'))).toBe(false);
      expect(result.failures.some((f) => f.includes('surplus'))).toBe(false);
    }, 300_000);

    it('a pass without a deadlock leaves the layout without sinks, and the improvement loop keeps to the same netlist', async () => {
      const plan = await deuteronPlan();
      const v = recording([passed]);
      const result = solveWith(plan, v.fn);
      expect(result.layout).not.toBeNull();
      expect(surplusExportsIn(result.layout!, plan)).toEqual([]);
      expect(v.seen.map((x) => hasHydrogenExport(x.plan))).toEqual([false]);
    }, 300_000);

    it('a deadlock on a plan without candidates changes nothing: the next rung is the next margin, as before', async () => {
      const plan = await ingotPlan();
      expect(plan.surplus).toBeUndefined();
      const v = recording([deadlock, passed]);
      const phases: string[] = [];
      const result = solveWith(plan, v.fn, phases);
      expect(result.layout).not.toBeNull();
      expect(phases.filter((p) => p.startsWith('ladder:'))).toEqual(['ladder: margin 3 rejected', 'ladder: margin 4']);
      expect(result.failures.every((f) => f.startsWith('margin 3: '))).toBe(true);
    }, 120_000);

    it('a sinkless layout of a plan with candidates is validated with the deadlock probe, one with the sinks on is not', async () => {
      const plan = await deuteronPlan();
      const v = recording([deadlock, rejection, passed]);
      solveWith(plan, v.fn);
      expect(v.seen.map((x) => x.probe)).toEqual([DEADLOCK_PROBE_TICKS, undefined, undefined]);
      expect(DEADLOCK_PROBE_TICKS).toBeGreaterThanOrEqual(1_000_000);
    }, 300_000);

    it('a deadlock that only the probe sees switches the sinks on like any other: the same rung is built again with them', async () => {
      const plan = await deuteronPlan();
      // the validator passes the layout unless it is asked for the probe, which finds it stuck; with the sinks on it asks for none
      const seen: { plan: ProductionPlan; probe: number | undefined }[] = [];
      const fn = ((layout, p, _d, _fx, o) => {
        const probe = (o as ValidateOptions).deadlockProbeTicks;
        seen.push({ plan: p, probe });
        return probe !== undefined ? probeDeadlock : passed;
      }) as typeof validateLayout;
      const phases: string[] = [];
      const result = solveWith(plan, fn, phases);
      expect(seen.map((x) => [hasHydrogenExport(x.plan), x.probe !== undefined])).toEqual([[false, true], [true, false]]);
      expect(phases.filter((p) => p.startsWith('ladder:'))).toEqual([
        'ladder: margin 3 deadlocked; Hydrogen gets a surplus export from here on',
        'ladder: margin 3 (surplus export)',
      ]);
      expect(result.failures).toEqual(['margin 3: SIM_DEADLOCK: the measurement made progress, but at tick 1000000 of the run nothing did']);
      expect(result.report).toBe(passed);
      expect(surplusExportsIn(result.layout!, plan).map((x) => x.itemId)).toEqual([HYDROGEN]);
    }, 300_000);

    it('a plan with no candidates never probes: no rung, and no improvement candidate, is validated with a probe', async () => {
      const plan = await ingotPlan();
      const v = recording([rejection, passed]);
      const fake = fakeClock(1_000);
      solve(plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, ...SIM, seed: 7, minRunMs: 1e9, timeBudgetMs: 6_000, now: fake.now }, (p) => fake.onProgress(p), () => {}, () => false, v.fn);
      expect(v.seen.length).toBeGreaterThan(2); // the ladder's two rungs, and improvement candidates
      expect(v.seen.every((x) => x.probe === undefined)).toBe(true);
    }, 120_000);

    it('the improvement loop probes the candidates of a plan with candidates, and turns one down for a deadlock at the horizon', async () => {
      // the ingot plan with a made-up candidate: only whether a probe is asked for matters here
      const plan: ProductionPlan = { ...(await ingotPlan()), surplus: [{ itemId: 1101, perSecond: 0.1 }] };
      const seen: (number | undefined)[] = [];
      let calls = 0;
      const fn = ((_layout, _p, _d, _fx, o) => {
        const probe = (o as ValidateOptions).deadlockProbeTicks;
        seen.push(probe);
        return ++calls === 1 || probe === undefined ? passed : probeDeadlock; // the ladder's layout is fine, the candidates get stuck late
      }) as typeof validateLayout;
      const fake = fakeClock(1_000);
      const phases: string[] = [];
      const improved = vi.fn();
      const result = solve(
        plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, ...SIM, seed: 7, minRunMs: 1e9, timeBudgetMs: 12_000, now: fake.now },
        (p) => fake.onProgress(p, (q) => phases.push(q.phase)), improved, () => false, fn,
      );
      expect(seen[0]).toBe(DEADLOCK_PROBE_TICKS); // the ladder's layout
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.every((x) => x === DEADLOCK_PROBE_TICKS)).toBe(true); // and every candidate: the sinks are not on
      expect(phases.some((p) => /^improve: margin \d rejected by the simulation$/.test(p))).toBe(true);
      expect(improved).toHaveBeenCalledTimes(1); // only the ladder's layout was ever the best
      expect(result.report).toBe(passed);
    }, 120_000);

    it('the budget message counts rungs, not attempts: a rung built again with the sinks is one rung', async () => {
      const plan = await deuteronPlan();
      const v = recording([deadlock, rejection]); // rung 1 deadlocks and is built again, rung 2 is turned down, the budget ends the ladder before rung 3
      const fake = fakeClock(1_000);
      const result = solve(
        plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, ...SIM, timeBudgetMs: 1, ladderBudgetMs: 3_500, now: fake.now },
        (p) => fake.onProgress(p), () => {}, () => false, v.fn,
      );
      expect(result.stoppedBy).toBe('budget');
      expect(result.attempts).toBe(3); // three layouts were built...
      expect(result.failures.at(-1)).toMatch(/^no valid layout within the time budget of 4 s: the ladder tried 2 of its 6 rungs/); // ...of two rungs
    }, 300_000);

    it('a deadlock after a layout has passed over the longer window does not switch: the improvement loop would mix two netlists', async () => {
      const plan = await deuteronPlan();
      // rung 1: a near miss, then the doubled window passes; rung 2 deadlocks; rung 3 is turned down; the exact rungs are not tried
      const v = recording([nearMiss(0.985), longerWindowPass, deadlock, rejection]);
      const phases: string[] = [];
      const result = solveWith(plan, v.fn, phases);
      expect(phases.some((p) => p.includes('surplus'))).toBe(false);
      expect(v.seen.every((x) => !hasHydrogenExport(x.plan))).toBe(true);
      expect(result.layout).not.toBeNull();
      expect(result.report).toBe(longerWindowPass);
      expect(surplusExportsIn(result.layout!, plan)).toEqual([]);
    }, 300_000);
  });

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

describe('solve with dense motifs', () => {
  /** The matrix chain fills over a few game minutes: a warm-up of two. */
  const ADAPTIVE = { simWarmupTicks: 7_200, simMeasureTicks: 3_600 };

  /**
   * 1 Magnetic Coil/s on base-tier machines: four machines. The direct-insertion motif can group all four (three
   * internal sorters) and the sandwich motif can put them on shared belts; which of them gives the smallest layout
   * depends on the run (the e2e test (f) names the one that wins on its seed).
   */
  const coilPlan = (): Promise<ProductionPlan> =>
    planFor({
      targetItemId: 1202,
      suppliedItemIds: new Set([1001, 1002]),
      finalFacilityItemId: ASSEMBLER,
      facilityOverrides: { 6: ASSEMBLER, 1: SMELTER, 2: SMELTER, 3: SMELTER },
    });

  /**
   * A run on a clock that moves one step per iteration of the ordinary chain and not at all for the motif chains, so
   * that runs with and without motifs have the same budget in ordinary iterations.
   */
  function runWith(plan: ProductionPlan, over: Partial<SolveOptions>, steps: number, fx = effects) {
    const clock = { t: 0 };
    const improved: { layout: Layout; report: ValidationReport; footprint: number; phase: string }[] = [];
    const phases: string[] = [];
    let phase = '';
    const result = solve(
      plan,
      data,
      fx,
      { ...DEFAULT_SOLVE_OPTIONS, ...SIM, seed: 7, minRunMs: 1e9, timeBudgetMs: steps * 1_000, ...over, now: () => clock.t },
      (p) => {
        phases.push(p.phase);
        phase = p.phase;
        if (p.phase !== 'done' && !p.phase.startsWith('motif')) clock.t += 1_000;
      },
      (layout, report, footprint) => improved.push({ layout, report, footprint, phase }),
      () => false,
    );
    return { result, improved, phases };
  }

  it('is off by default: no motif iteration runs, and the motifs-off run is the run of before', async () => {
    expect(DEFAULT_SOLVE_OPTIONS.useUnverifiedMotifs).toBe(false);
    expect(VERIFIED_MOTIFS.size).toBe(0);
    const r = runWith(await coilPlan(), {}, 8);
    expect(r.phases.some((p) => p.startsWith('motif'))).toBe(false);
    expect(r.result.failures).toEqual([]);
  }, 120_000);

  it('with useUnverifiedMotifs the loop also works on motif netlists, and every layout it emits passes the validator', async () => {
    const plan = await coilPlan();
    const r = runWith(plan, { useUnverifiedMotifs: true }, 10);
    expect(r.phases.some((p) => p.startsWith('motif'))).toBe(true);
    expect(r.result.failures).toEqual([]);
    expect(r.improved.length).toBeGreaterThanOrEqual(1);
    for (const imp of r.improved) {
      expect(messages(imp.report)).toEqual([]);
      const again = validateLayout(imp.layout, plan, data, effects, { warmupTicks: SIM.simWarmupTicks, measureTicks: SIM.simMeasureTicks });
      expect(messages(again)).toEqual([]);
      expect(imp.footprint).toBeCloseTo(footprintOf(imp.layout, data), 9);
    }
    r.improved.forEach((imp, i) => {
      if (i > 0) expect(imp.footprint).toBeLessThan(r.improved[i - 1].footprint);
    });
    expect(r.result.layout).toBe(r.improved[r.improved.length - 1].layout);
  }, 180_000);

  it('uses the motifs in VERIFIED_MOTIFS without being asked, and only those', async () => {
    const plan = await matrixPlan(2);
    const fx = { ...effects, labLevel: 3 };
    VERIFIED_MOTIFS.add('labStack');
    try {
      const r = runWith(plan, ADAPTIVE, 6, fx);
      expect(r.result.failures).toEqual([]);
      const motifPhases = r.phases.filter((p) => p.startsWith('motif'));
      expect(motifPhases.length).toBeGreaterThan(0);
      expect(motifPhases.every((p) => p.startsWith('motif labStack:'))).toBe(true);
    } finally {
      VERIFIED_MOTIFS.delete('labStack');
    }
    expect(VERIFIED_MOTIFS.size).toBe(0);
  }, 180_000);

  it('a motif layout that the simulation rejects does not become the floor of its chain: later candidates of that size are still validated', async () => {
    const plan = await coilPlan();
    const rejection: ValidationReport = {
      pass: false,
      violations: [{ code: 'SIM_STALLED', entities: [], message: 'made up' }],
      checkedAt: '',
      stage: 'simulation',
    };
    // reject every layout with a sorter between two buildings, so that only the direct-insertion chain is judged
    const judged: number[] = [];
    const validator = ((layout, p, d, fx, o) => {
      if (!layout.sorters.some((x) => x.pick.kind === 'building' && x.drop.kind === 'building')) return validateLayout(layout, p, d, fx, o);
      judged.push(footprintOf(layout, d));
      return rejection;
    }) as typeof validateLayout;
    const clock = { t: 0 };
    VERIFIED_MOTIFS.add('direct'); // the direct-insertion chain alone: nothing else lowers the overall best meanwhile
    let result: SolveResult;
    try {
      result = solve(
        plan, data, effects,
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, seed: 1, minRunMs: 1e9, timeBudgetMs: 10_000, now: () => clock.t },
        (p) => {
          if (p.phase !== 'done' && !p.phase.startsWith('motif')) clock.t += 1_000;
        },
        () => {},
        () => false,
        validator,
      );
    } finally {
      VERIFIED_MOTIFS.delete('direct');
    }
    // a candidate as large as one the simulation turned down was still validated: the rejected one is no floor
    expect(judged.length).toBeGreaterThanOrEqual(2);
    expect(judged.some((f, i) => i > 0 && f >= Math.min(...judged.slice(0, i)) - 1e-9)).toBe(true);
    expect(result.layout!.sorters.every((x) => x.pick.kind !== 'building' || x.drop.kind !== 'building')).toBe(true);
    expect(result.failures).toEqual([]);
  }, 120_000);

  it('a motif layout that passes only over the doubled window does not replace a best that passes the plain one', async () => {
    const plan = await coilPlan();
    // every layout with a sorter between two buildings is a near miss that the doubled window passes; the others get the real validator
    const judged: number[] = [];
    const validator = ((layout, p, d, fx, o) => {
      if (!layout.sorters.some((x) => x.pick.kind === 'building' && x.drop.kind === 'building')) return validateLayout(layout, p, d, fx, o);
      const wanted = layout.meta.planTargetRate;
      if (o?.measureTicks === SIM.simMeasureTicks) {
        judged.push(footprintOf(layout, d));
        return {
          ...nearMiss(),
          sim: { measuredTargetRate: 0.985 * wanted, measureSeconds: SIM.simMeasureTicks / 60, warmupTicksUsed: 1200, deadlocked: false } as SimResult,
        };
      }
      return { ...longerWindowPass, sim: { ...longerWindowPass.sim!, measuredTargetRate: wanted, measureSeconds: (2 * SIM.simMeasureTicks) / 60 } as SimResult };
    }) as typeof validateLayout;
    const clock = { t: 0 };
    const emitted: Layout[] = [];
    VERIFIED_MOTIFS.add('direct');
    let result: SolveResult;
    try {
      result = solve(
        plan, data, effects,
        { ...DEFAULT_SOLVE_OPTIONS, ...SIM, seed: 1, minRunMs: 1e9, timeBudgetMs: 10_000, now: () => clock.t },
        (p) => {
          if (p.phase !== 'done' && !p.phase.startsWith('motif')) clock.t += 1_000;
        },
        (layout) => emitted.push(layout),
        () => false,
        validator,
      );
    } finally {
      VERIFIED_MOTIFS.delete('direct');
    }
    expect(judged.length).toBeGreaterThanOrEqual(1); // motif layouts were smaller than the best and reached the validator
    expect(emitted.every((l) => l.sorters.every((x) => x.pick.kind !== 'building' || x.drop.kind !== 'building'))).toBe(true);
    expect(result.layout!.sorters.every((x) => x.pick.kind !== 'building' || x.drop.kind !== 'building')).toBe(true);
    expect(result.failures).toEqual([]);
  }, 120_000);

  it('does not touch the ordinary chain: with motifs on and no motif layout better, the result is the ordinary one', async () => {
    // the ingot plan has nothing a motif can do (a single stage of identical smelters makes sandwiches only)
    const plan = await ingotPlan();
    const without = runWith(plan, {}, 8);
    const withMotifs = runWith(plan, { useUnverifiedMotifs: true }, 8);
    expect(withMotifs.result.footprint).toBeLessThanOrEqual(without.result.footprint as number);
    expect(withMotifs.result.failures).toEqual([]);
  }, 180_000);
});

describe('solve with a proliferator (Task 28)', () => {
  /** The geometry and capacity checks, no simulation: quick. */
  const STATIC = { simulate: false };

  it('the ladder is the same six rungs as without a proliferator: the room for the coaters is made at every margin, not asked for at the last', async () => {
    const plan = await processorPlan(1, { tier: 3, mode: 'extra' });
    // the rungs build and pass the static checks; the full validator (scripted) turns all six down
    const reject = { pass: false, violations: [{ code: 'SIM_STALLED' as const, entities: [], message: 'made up' }], checkedAt: '', stage: 'simulation' as const };
    const validate = (() => reject) as unknown as typeof validateLayout;
    const phases: string[] = [];
    const fake = fakeClock(1000);
    solve(
      plan, data, effects,
      { ...DEFAULT_SOLVE_OPTIONS, ...STATIC, seed: 7, timeBudgetMs: 0, minRunMs: 1e9, now: fake.now },
      (p) => fake.onProgress(p, (q) => phases.push(q.phase)), () => {}, () => false, validate,
    );
    expect(phases.filter((p) => p.startsWith('ladder'))).toEqual([
      'ladder: margin 3 rejected',
      'ladder: margin 4 rejected',
      'ladder: margin 6 rejected',
      'ladder: margin 3 (exact routes) rejected',
      'ladder: margin 4 (exact routes) rejected',
      'ladder: margin 6 (exact routes) rejected',
    ]);
  }, 60_000);

  it('High-Explosive Shell Set with Mk.III has a coating window on every sprayed net at the first rung (it had none at margins 3 and 4)', async () => {
    const itemId = data.data.items.find((i) => i.name === 'High-Explosive Shell Set')!.id;
    const raw = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1030, 1031];
    const plan = await planFor({ targetItemId: itemId, suppliedItemIds: new Set(raw), proliferator: { tier: 3, mode: 'extra' } });
    const out = run(plan, { ...STATIC, timeBudgetMs: 0 }, 1000);
    expect(out.result.failures).toEqual([]);
    expect(out.progress.map((p) => p.phase).filter((p) => p.startsWith('ladder'))).toEqual(['ladder: margin 3']);
    const layout = out.result.layout as Layout;
    const sprayed = buildNetlist(plan, data, effects).nets.filter((n) => n.sprayed);
    expect(sprayed.length).toBeGreaterThan(5);
    expect(layout.coaters!.map((c) => c.beltId)).toEqual(sprayed.map((n) => n.id));
  }, 60_000);

  it('the ladder\'s first rung lays the network: a coater on every sprayed net, a feed belt of the proliferator, and it passes', async () => {
    const plan = await processorPlan(1, { tier: 3, mode: 'extra' });
    const out = run(plan, { ...STATIC, timeBudgetMs: 0 }, 1000);
    const layout = out.result.layout as Layout;
    expect(out.result.failures).toEqual([]);
    expect(out.result.report?.pass).toBe(true);
    expect(out.progress.map((p) => p.phase).filter((p) => p.startsWith('ladder'))).toEqual(['ladder: margin 3']);
    expect(layout.coaters).toHaveLength(8);
    expect(new Set(layout.coaters!.map((c) => c.beltId)).size).toBe(8);
    const feeds = layout.belts.filter((b) => b.itemId === 1143);
    expect(feeds).toHaveLength(1);
    expect(feeds[0].source).toBeDefined();
    expect(feeds[0].sink).toBeUndefined();
    // the coaters are consumers: powered by the nodes the solver placed
    expect(layout.buildings.some((b) => b.role === 'power')).toBe(true);
    // the layout the solver emits is the one a fresh validation passes
    expect(validateLayout(layout, plan, data, effects, { simulate: false }).pass).toBe(true);
  }, 60_000);

  it('without a proliferator the layout has no coaters and no feed: the pipeline is the old one', async () => {
    const plan = await processorPlan(1);
    const out = run(plan, { ...STATIC, timeBudgetMs: 0 }, 1000);
    const layout = out.result.layout as Layout;
    expect(layout.coaters).toBeUndefined();
    expect(layout.belts.some((b) => b.itemId === 1141 || b.itemId === 1142 || b.itemId === 1143)).toBe(false);
  }, 60_000);
});
