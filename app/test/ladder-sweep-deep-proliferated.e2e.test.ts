// Deep fallback ladder sweep with a proliferator (Task 30b): the sweep of ladder-sweep-deep.e2e.test.ts with Mk.III proliferator
// (extra products) on every stage, as ladder-sweep-proliferated.e2e.test.ts is to ladder-sweep.e2e.test.ts. Run it with
// `npm run test:sweep-deep`; `npm run test:e2e` leaves it out.
import { plannableItems, sweep } from './ladderSweep';

sweep('deep fallback ladder sweep with Mk.III proliferator [slow]', await plannableItems({ tier: 3, mode: 'extra' }, 'deep'), 'deep');
