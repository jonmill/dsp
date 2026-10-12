// Fallback ladder sweep (Task 24b): spec §6.2 says that failing to produce a valid layout from the relaxed fallback, for
// any plan the calculator emits, is a bug. So every item `planProduction` can plan at 1/s (all techs unlocked, the raw
// resources supplied, at most 12 recipe stages) is solved with the fallback ladder alone (`timeBudgetMs: 1` ends the
// improvement loop at once) and with the validator's default, adaptive simulation; the layout has to exist and pass a
// plain `validateLayout`. The facility of the last stage is the first unlocked one that can run the item's first
// plannable recipe (a lab for the matrices, which `buildingsForRecipeType` does not list). An item that fails is a
// failure of its own test, with the violations as the message. Nothing is skipped silently: the items left out are
// listed in `EXPECTED_SKIPPED` and the test fails when the list or the number of items swept changes, so a shrinking
// sweep cannot go unnoticed.
//
// No allowance: every layout has to pass the plain window. The solver's own near-miss rule (`validateGated`: a layout whose
// only violation is SIM_OUTPUT_LOW, less than 2 % short, is measured once more over twice the window and that verdict stands)
// does not count here. Hydrogen Fuel Rod used to pass only that way (its four final-stage machines work in step, so its 60 s
// windows alternate between 0.933 and 1.067 of the rate and a 300 s window reads 0.987 or 1.000 depending on where it starts);
// since Task 27 the ladder keeps such a layout for the end of its rungs and takes the first rung that passes the plain window,
// and Hydrogen Fuel Rod has one. The threshold (99 % of the rate) is the validator's, unchanged.
// Slow: about 2 minutes, logging the runtime of every item. Run with `npm run test:e2e`; `npm test` leaves it out.
import { plannableItems, sweep } from './ladderSweep';

sweep('fallback ladder sweep [slow]', await plannableItems());
