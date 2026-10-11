// A small seeded random source for the solver, so a layout is reproducible from its seed.

/** mulberry32: 32 bits of state, one `Math.imul` mix per draw. Fast and good enough for annealing moves. */
export class Rng {
  private state: number;

  /** Any number works as a seed; it is truncated to 32 bits (`NaN` counts as 0). */
  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** The next draw, uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** The next draw as an integer in [0, n). `n` must be a positive integer. */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`Rng.int needs a positive integer, got ${n}`);
    return Math.floor(this.next() * n);
  }
}
