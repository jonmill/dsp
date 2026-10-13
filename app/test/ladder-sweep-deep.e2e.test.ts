// Deep fallback ladder sweep (Task 30b): the sweep of ladder-sweep.e2e.test.ts over the items it leaves out for having more than
// 12 stages (Space Warper, Gravity Matrix, Quantum Chip, Plasma Turret, Small Carrier Rocket ...): spec §6.2 says that failing to
// produce a valid layout from the relaxed fallback for any plan the calculator emits is a bug, deep or not. Same method: plan at
// 1/s, all techs, the raw items supplied, the first unlocked facility; the fallback ladder alone (`timeBudgetMs: 1`); a plain
// `validateLayout` with the default, adaptive simulation, which waits for a slow start-up (`SimOptions.acceptable`). No allowance:
// an item that fails fails its own test, with the violations as the message, and the run logs its rung, rate and runtime.
// Too slow for `npm run test:e2e` (tens of minutes, hundreds of machines in the biggest plans): run it with `npm run test:sweep-deep`.
import { plannableItems, sweep } from './ladderSweep';

sweep('deep fallback ladder sweep [slow]', await plannableItems({ tier: 0, mode: 'extra' }, 'deep'), 'deep');
