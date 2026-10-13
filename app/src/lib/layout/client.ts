// The main-thread side of the solver worker (Task 24): `startSolve` starts a solve in a Web Worker and hands back a
// way to stop it and a promise of the result. See `worker.ts` and `protocol.ts`.
import type { ProductionPlan } from '../calc';
import type { GameDataIndex, TechEffects } from '../data';
import type { Layout } from '../geometry';
import type { ValidationReport } from '../validate';
import { serializeEffects, serializePlan } from './protocol';
import type { ClientMessage, WireSolveOptions, WorkerMessage } from './protocol';
import type { SolveProgress, SolveResult } from './solver';

export interface SolveCallbacks {
  onProgress?: (progress: SolveProgress) => void;
  onImproved?: (layout: Layout, report: ValidationReport, footprint: number) => void;
}

export interface SolveHandle {
  /** Asks the solver to stop; `done` then resolves with the best layout found, `stoppedBy: 'user'`. */
  stop(): void;
  /** Resolves with the result; rejects if the plan could not be solved at all or the worker failed. */
  done: Promise<SolveResult>;
}

/** The worker as the client uses it: the real one is wrapped, a test passes a stand-in. */
export interface WorkerLike {
  post(message: ClientMessage): void;
  /** Called with every message of the worker, and with the text of an error that ended it. */
  listen(onMessage: (message: WorkerMessage) => void, onError: (message: string) => void): void;
  terminate(): void;
}

/**
 * How long, in milliseconds, a stop may wait for the worker to reach its next candidate before the client gives up
 * on it, terminates it and answers with the best layout it was sent.
 */
export const STOP_GRACE_MS = 2000;

/**
 * How long, in milliseconds, past its time budget a solve that set `ladderBudgetMs` may take before the client terminates the
 * worker and answers with what it has (`stoppedBy: 'budget'`). The solver stops itself at the budget, in the middle of a routing or
 * a simulation too, so this is the backstop for a step that does not look at the clock (a placement of thousands of machines).
 */
export const BUDGET_GRACE_MS = 5000;

/** The message of a solve that ended at its budget with no layout (the solver's own, in `SolveResult.failures`, says the same). */
export const budgetMessage = (budgetMs: number, phase: string | undefined): string =>
  `no valid layout within the time budget of ${Math.round(budgetMs / 1000)} s (stopped while: ${phase ?? 'starting'})`;

function browserWorker(): WorkerLike {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return {
    post: (message) => worker.postMessage(message),
    listen: (onMessage, onError) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => onMessage(event.data);
      worker.onerror = (event: ErrorEvent) => onError(event.message || 'the solver worker failed');
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * Starts solving `plan` in a worker. `opts` has no clock (a function does not travel; the worker uses its own).
 * `createWorker` is for tests.
 */
export function startSolve(
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  opts: WireSolveOptions,
  callbacks: SolveCallbacks = {},
  createWorker: () => WorkerLike = browserWorker,
): SolveHandle {
  const worker = createWorker();
  let settled = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let lastProgress: SolveProgress | undefined;
  let best: { layout: Layout; report: ValidationReport; footprint: number } | undefined;

  let resolve!: (result: SolveResult) => void;
  let reject!: (error: Error) => void;
  const done = new Promise<SolveResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const settle = (finish: () => void): void => {
    if (settled) return;
    settled = true;
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    worker.terminate();
    finish();
  };

  worker.listen(
    (message) => {
      if (settled) return;
      switch (message.type) {
        case 'progress':
          lastProgress = message.progress;
          callbacks.onProgress?.(message.progress);
          break;
        case 'improved':
          best = { layout: message.layout, report: message.report, footprint: message.footprint };
          callbacks.onImproved?.(message.layout, message.report, message.footprint);
          break;
        case 'done':
          settle(() => resolve(message.result));
          break;
        case 'error':
          settle(() => reject(new Error(message.message)));
          break;
      }
    },
    (message) => settle(() => reject(new Error(message))),
  );

  worker.post({ type: 'start', plan: serializePlan(plan), data: data.data, effectsSerialized: serializeEffects(effects), opts });

  /** The answer of a worker that is given up on: what it sent last, and who gave up. */
  const answerWith = (stoppedBy: SolveResult['stoppedBy'], failures: string[]): SolveResult => ({
    layout: best?.layout ?? null,
    report: best?.report ?? null,
    footprint: best?.footprint ?? null,
    attempts: lastProgress?.attempts ?? 0,
    validated: lastProgress?.validated ?? 0,
    stoppedBy,
    failures,
  });
  // A solve whose ladder is bound by a budget is bound by it as a whole: past the budget and the grace the worker is stopped
  // whatever it is doing, and the answer is its best so far (or no layout, and the reason).
  if (opts.ladderBudgetMs !== undefined) {
    const budgetMs = Math.max(opts.timeBudgetMs, opts.ladderBudgetMs);
    budgetTimer = setTimeout(
      () => settle(() => resolve(answerWith('budget', best ? [] : [budgetMessage(opts.ladderBudgetMs ?? budgetMs, lastProgress?.phase)]))),
      budgetMs + BUDGET_GRACE_MS,
    );
  }

  return {
    done,
    stop: () => {
      if (settled || stopTimer !== undefined) return;
      worker.post({ type: 'stop' });
      stopTimer = setTimeout(() => {
        // the worker is in the middle of a long candidate: answer with what it has sent
        settle(() => resolve(answerWith('user', [])));
      }, STOP_GRACE_MS);
    },
  };
}
