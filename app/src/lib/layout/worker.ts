// The solver as a Web Worker (Task 24). The client sends `start` with the plan, the GameData, the serialized tech
// effects and the options, and may send `stop`; the worker posts `progress` and `improved` as they happen, then `done`
// with the result (or `error` if the plan could not be solved at all). See `protocol.ts`.
//
// `solve` is synchronous, so a `stop` message could not be read while it ran. The worker runs `solveSteps` instead and
// gives the event loop a turn between candidates; a stop is acted on at the next one. (A client that cannot wait for
// a long candidate to end terminates the worker; see `client.ts`.)
import { GameDataIndex } from '../data';
import { deserializeEffects, deserializePlan } from './protocol';
import type { ClientMessage, WorkerMessage } from './protocol';
import { solveSteps } from './solver';

/** What the worker needs of its global scope; `self` in a worker, a stand-in in tests. */
export interface WorkerPort {
  postMessage(message: WorkerMessage): void;
  onmessage: ((event: { data: ClientMessage }) => void) | null;
}

/** A turn of the event loop, in which queued messages are delivered. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Makes `port` answer `start` and `stop` messages. `turn` is what the solver waits on between candidates. */
export function attachSolver(port: WorkerPort, turn: () => Promise<void> = nextTurn): void {
  let running = false;
  let stopRequested = false;

  const run = async (msg: Extract<ClientMessage, { type: 'start' }>): Promise<void> => {
    running = true;
    stopRequested = false;
    try {
      const data = new GameDataIndex(msg.data);
      const steps = solveSteps(
        deserializePlan(msg.plan),
        data,
        deserializeEffects(msg.effectsSerialized),
        msg.opts,
        (progress) => port.postMessage({ type: 'progress', progress }),
        (layout, report, footprint) => port.postMessage({ type: 'improved', layout, report, footprint }),
        () => stopRequested,
      );
      for (;;) {
        const next = steps.next();
        if (next.done) {
          port.postMessage({ type: 'done', result: next.value });
          return;
        }
        await turn();
      }
    } catch (err) {
      port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };

  port.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'stop') stopRequested = true;
    else if (running) port.postMessage({ type: 'error', message: 'the solver is already running' });
    else void run(msg);
  };
}

// In a worker, listen on the global scope. (Elsewhere, such as a test importing this file, nothing is attached.)
declare const WorkerGlobalScope: (abstract new () => object) | undefined;
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  attachSolver(self as unknown as WorkerPort);
}
