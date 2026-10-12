// Fallback ladder sweep with a proliferator (Task 28, fix round 1): the sweep of ladder-sweep.e2e.test.ts, over the same
// items, with Mk.III proliferator on every stage (extra products). Every item has to come out of the ladder alone
// (`timeBudgetMs: 1`) as a layout that passes a plain `validateLayout` with the default, adaptive simulation: the coaters of
// every sprayed net have their room, the feed belt reaches them all, and the plan's rate (which counts the +25 %) is made.
// No allowance, as in the plain sweep. A plan with a proliferator is bigger (a net per sprayed item, a coater on each and a
// feed through all of them) and its simulation waits for belts to fill (`MAX_FILL_WARMUP_TICKS`), so this takes longer than
// the plain sweep: it logs the runtime of every item and the total. Run with `npm run test:e2e`.
import { plannableItems, sweep } from './ladderSweep';

sweep('fallback ladder sweep with Mk.III proliferator [slow]', await plannableItems({ tier: 3, mode: 'extra' }));
