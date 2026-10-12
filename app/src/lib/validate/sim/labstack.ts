// A stack of labs as the simulator moves it (MX §4.4, §8): each lab passes the ingredients it does not need up to the
// lab above it, and the lab below pulls the products down, so only the bottom lab is fed and unloaded by sorters.
// The labs are ordinary `MachineSim`s that craft on their own; this entity runs after them each tick and moves items
// between neighbours (see `MachineSim.passIngredientsUp` / `pullProductsDown` for the rules and what is assumed).
import type { MachineSim } from './machine';

export class LabStack {
  /** `labs` from the bottom of the stack to the top. */
  constructor(readonly labs: readonly MachineSim[]) {}

  tick(): void {
    // ingredients climb one level a tick, from the bottom up; products come down the whole stack, from the top
    for (let k = 0; k + 1 < this.labs.length; k++) this.labs[k].passIngredientsUp(this.labs[k + 1]);
    for (let k = this.labs.length - 2; k >= 0; k--) this.labs[k].pullProductsDown(this.labs[k + 1]);
  }
}
