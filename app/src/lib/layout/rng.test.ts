import { describe, expect, it } from 'vitest';
import { Rng } from './rng';

describe('Rng (mulberry32)', () => {
  it('matches the reference mulberry32 sequence', () => {
    // the canonical 32-bit mulberry32, written out independently of rng.ts
    const ref = (seed: number) => {
      let a = seed | 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    for (const seed of [0, 1, 42, 0xdeadbeef]) {
      const rng = new Rng(seed);
      const expected = ref(seed);
      for (let i = 0; i < 50; i++) expect(rng.next()).toBe(expected());
    }
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    const c = new Rng(8);
    const as = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(as);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(as);
  });

  it('next() stays in [0, 1) and looks uniform', () => {
    const rng = new Rng(3);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
  });

  it('int(n) is an integer in [0, n) that reaches every value', () => {
    const rng = new Rng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = rng.int(6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
    expect(rng.int(1)).toBe(0);
  });

  it('int(n) rejects a bound that is not a positive integer', () => {
    const rng = new Rng(1);
    for (const n of [0, -3, 2.5, NaN, Infinity]) expect(() => rng.int(n)).toThrow(RangeError);
  });

  it('takes any numeric seed (negative, fractional) without throwing', () => {
    for (const seed of [-1, 1.5, 2 ** 40, NaN]) {
      const v = new Rng(seed).next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
