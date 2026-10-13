import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductionPlan } from '../calc';
import { BUDGET_GRACE_MS, budgetMessage, startSolve, STOP_GRACE_MS } from './client';
import type { WorkerLike } from './client';
import { deserializeEffects, deserializePlan, serializeEffects, serializePlan } from './protocol';
import type { ClientMessage, WireSolveOptions, WorkerMessage } from './protocol';
import { DEFAULT_SOLVE_OPTIONS } from './solver';
import type { SolveResult } from './solver';
import { attachSolver } from './worker';
import type { WorkerPort } from './worker';
import { data, effects, planFor, SMELTER } from './testkit';

const ingotPlan = (): Promise<ProductionPlan> =>
  planFor({
    targetItemId: 1101,
    finalFacilityItemId: SMELTER,
    quantity: { kind: 'rate', perSecond: 3 },
    suppliedItemIds: new Set([1001]),
  });

const OPTS: WireSolveOptions = { ...DEFAULT_SOLVE_OPTIONS, simWarmupTicks: 1200, simMeasureTicks: 3600 };

/** The worker run in this thread: every message crosses by structured clone and a turn of the event loop. */
function inProcessWorker(sent: ClientMessage[] = []): WorkerLike & { terminated: boolean } {
  let deliver: (m: WorkerMessage) => void = () => {};
  const port: WorkerPort = {
    postMessage: (m) => {
      const copy = structuredClone(m);
      setTimeout(() => deliver(copy), 0);
    },
    onmessage: null,
  };
  attachSolver(port);
  const w = {
    terminated: false,
    post: (m: ClientMessage) => {
      sent.push(m);
      const copy = structuredClone(m);
      setTimeout(() => port.onmessage?.({ data: copy }), 0);
    },
    listen: (onMessage: (m: WorkerMessage) => void) => {
      deliver = onMessage;
    },
    terminate: () => {
      w.terminated = true;
      deliver = () => {};
    },
  };
  return w;
}

describe('protocol', () => {
  it('turns the Sets of the plan and the tech effects into arrays and back', async () => {
    const plan = await planFor({ targetItemId: 1101, finalFacilityItemId: SMELTER, suppliedItemIds: new Set([1001, 1002]) });
    const wire = serializePlan(plan);
    expect(wire.request.suppliedItemIds).toEqual([1001, 1002]);
    expect(Array.isArray(wire.request.unlockedTechs)).toBe(true);
    // plain data: JSON carries it
    expect(deserializePlan(JSON.parse(JSON.stringify(wire)))).toEqual(plan);

    const fx = serializeEffects(effects);
    expect(Array.isArray(fx.unlockedRecipes) && Array.isArray(fx.availableBuildings)).toBe(true);
    expect(deserializeEffects(JSON.parse(JSON.stringify(fx)))).toEqual(effects);
  });
});

describe('worker and client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('solves in the worker: progress and improvements arrive, then the result', async () => {
    const plan = await ingotPlan();
    const sent: ClientMessage[] = [];
    const progress: string[] = [];
    const improved: number[] = [];
    const worker = inProcessWorker(sent);
    const handle = startSolve(plan, data, effects, { ...OPTS, timeBudgetMs: 2500, minRunMs: 1e9 }, {
      onProgress: (p) => progress.push(p.phase),
      onImproved: (_l, r, f) => {
        expect(r.pass).toBe(true);
        improved.push(f);
      },
    }, () => worker);
    const result = await handle.done;
    expect(sent[0].type).toBe('start');
    expect(result.stoppedBy).toBe('budget');
    expect(result.layout).not.toBeNull();
    expect(result.report!.pass).toBe(true);
    expect(improved.length).toBeGreaterThanOrEqual(1);
    expect(result.footprint).toBe(improved[improved.length - 1]);
    expect(progress[0]).toBe('start');
    expect(progress[progress.length - 1]).toBe('done');
    expect(worker.terminated).toBe(true);
  }, 60_000);

  it('stops on request and returns the best found', async () => {
    const plan = await ingotPlan();
    const started = performance.now();
    let improvements = 0;
    const handle = startSolve(plan, data, effects, { ...OPTS, timeBudgetMs: 600_000, minRunMs: 1e9 }, {
      onImproved: () => {
        if (++improvements === 1) handle.stop();
      },
    }, inProcessWorker);
    const result = await handle.done;
    expect(result.stoppedBy).toBe('user');
    expect(result.layout).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('terminates a worker that does not answer a stop, and answers with what it was sent', async () => {
    vi.useFakeTimers();
    let deliver: (m: WorkerMessage) => void = () => {};
    const posted: ClientMessage[] = [];
    let terminated = 0;
    const silent: WorkerLike = {
      post: (m) => posted.push(m),
      listen: (onMessage) => {
        deliver = onMessage;
      },
      terminate: () => terminated++,
    };
    const plan = await ingotPlan();
    const handle = startSolve(plan, data, effects, OPTS, {}, () => silent);
    const layout = { buildings: [], belts: [], sorters: [], meta: { geometrySource: 'approximate' as const, gameVersion: 'x', planTargetItemId: 1, planTargetRate: 1 } };
    const report = { pass: true, violations: [], checkedAt: '', stage: 'simulation' as const };
    deliver({ type: 'progress', progress: { elapsedMs: 5, attempts: 4, validated: 2, bestFootprint: 9, phase: 'improve' } });
    deliver({ type: 'improved', layout, report, footprint: 9 });
    handle.stop();
    handle.stop(); // once is enough
    expect(posted.map((m) => m.type)).toEqual(['start', 'stop']);
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const result: SolveResult = await handle.done;
    expect(terminated).toBe(1);
    expect(result).toEqual({ layout, report, footprint: 9, attempts: 4, validated: 2, stoppedBy: 'user', failures: [] });
  });

  describe('a solve whose ladder has a budget is bound by it (Task 30b)', () => {
    afterEach(() => vi.useRealTimers());
    const silentWorker = () => {
      let deliver: (m: WorkerMessage) => void = () => {};
      const posted: ClientMessage[] = [];
      let terminated = 0;
      const worker: WorkerLike = {
        post: (m) => posted.push(m),
        listen: (onMessage) => {
          deliver = onMessage;
        },
        terminate: () => terminated++,
      };
      return { worker, say: (m: WorkerMessage) => deliver(m), posted, terminated: () => terminated };
    };
    const BUDGET = { ...OPTS, timeBudgetMs: 60_000, ladderBudgetMs: 60_000 };

    it('terminates a worker that is still on the ladder past the budget and the grace, and answers with no layout, stoppedBy budget, and why', async () => {
      vi.useFakeTimers();
      const w = silentWorker();
      const handle = startSolve(await ingotPlan(), data, effects, BUDGET, {}, () => w.worker);
      w.say({ type: 'progress', progress: { elapsedMs: 5, attempts: 2, validated: 0, bestFootprint: null, phase: 'ladder: margin 4 failed' } });
      await vi.advanceTimersByTimeAsync(BUDGET.timeBudgetMs + BUDGET_GRACE_MS - 1);
      expect(w.terminated()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      const result = await handle.done;
      expect(w.terminated()).toBe(1);
      expect(result).toMatchObject({ layout: null, report: null, footprint: null, attempts: 2, stoppedBy: 'budget' });
      expect(result.failures).toEqual([budgetMessage(60_000, 'ladder: margin 4 failed')]);
      expect(result.failures[0]).toMatch(/^no valid layout within the time budget of 60 s/);
    });

    it('answers with the best layout it was sent when it is past the budget in the improvement loop, and names no failure', async () => {
      vi.useFakeTimers();
      const w = silentWorker();
      const handle = startSolve(await ingotPlan(), data, effects, BUDGET, {}, () => w.worker);
      const layout = { buildings: [], belts: [], sorters: [], meta: { geometrySource: 'approximate' as const, gameVersion: 'x', planTargetItemId: 1, planTargetRate: 1 } };
      const report = { pass: true, violations: [], checkedAt: '', stage: 'simulation' as const };
      w.say({ type: 'improved', layout, report, footprint: 9 });
      await vi.advanceTimersByTimeAsync(BUDGET.timeBudgetMs + BUDGET_GRACE_MS);
      const result = await handle.done;
      expect(result).toMatchObject({ layout, report, footprint: 9, stoppedBy: 'budget', failures: [] });
    });

    it('does nothing to a worker that answers in time, and nothing at all without a ladder budget (the sweeps\' ladder is the guarantee)', async () => {
      vi.useFakeTimers();
      const quick = silentWorker();
      const done = startSolve(await ingotPlan(), data, effects, BUDGET, {}, () => quick.worker);
      const result: SolveResult = { layout: null, report: null, footprint: null, attempts: 1, validated: 0, stoppedBy: 'exhausted', failures: ['x'] };
      quick.say({ type: 'done', result });
      await expect(done.done).resolves.toEqual(result);
      await vi.advanceTimersByTimeAsync(BUDGET.timeBudgetMs * 2);
      expect(quick.terminated()).toBe(1); // once, when it answered

      const unbounded = silentWorker();
      startSolve(await ingotPlan(), data, effects, { ...OPTS, timeBudgetMs: 60_000 }, {}, () => unbounded.worker);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(unbounded.terminated()).toBe(0);
    });
  });

  it('rejects when the worker reports an error or fails', async () => {
    const plan = await ingotPlan();
    const failures: ((say: (m: WorkerMessage) => void, crash: (text: string) => void) => void)[] = [
      (say) => say({ type: 'error', message: 'no netlist' }),
      (_say, crash) => crash('script error'),
    ];
    for (const fail of failures) {
      let go = () => {};
      const w: WorkerLike = {
        post: () => {},
        listen: (onMessage, onError) => {
          go = () => fail(onMessage, onError);
        },
        terminate: () => {},
      };
      const handle = startSolve(plan, data, effects, OPTS, {}, () => w);
      go();
      await expect(handle.done).rejects.toThrow(/no netlist|script error/);
    }
  });

  it('answers a second start while it runs with an error, and a plan it cannot solve with an error', async () => {
    const out: WorkerMessage[] = [];
    const port: WorkerPort = { postMessage: (m) => out.push(m), onmessage: null };
    attachSolver(port);
    const plan = await ingotPlan();
    const broken = { ...serializePlan(plan), stages: [{ ...plan.stages[0], buildingItemId: 99999 }] };
    const start = { type: 'start' as const, plan: broken, data: data.data, effectsSerialized: serializeEffects(effects), opts: OPTS };
    port.onmessage!({ data: start });
    port.onmessage!({ data: start });
    await vi.waitFor(() => expect(out.some((m) => m.type === 'error' && /already running/.test(m.message))).toBe(true));
    await vi.waitFor(() => expect(out.filter((m) => m.type === 'error')).toHaveLength(2));
  });
});
