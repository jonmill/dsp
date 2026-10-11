import { describe, expect, it } from 'vitest';
import { MinHeap } from './heap';

describe('MinHeap', () => {
  it('pops values in key order', () => {
    const h = new MinHeap();
    for (const [k, v] of [[5, 50], [1, 10], [3, 30], [2, 20], [4, 40]] as const) h.push(k, v);
    expect(h.size).toBe(5);
    const out: number[] = [];
    while (h.size > 0) out.push(h.pop());
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('peekKey is the smallest key and pop returns its value', () => {
    const h = new MinHeap();
    h.push(2.5, 7);
    h.push(0.5, 9);
    expect(h.peekKey()).toBe(0.5);
    expect(h.pop()).toBe(9);
    expect(h.peekKey()).toBe(2.5);
  });

  it('grows past its initial capacity and matches a sort', () => {
    const h = new MinHeap(2);
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const keys: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const k = Math.floor(rnd() * 1000) / 7;
      keys.push(k);
      h.push(k, i);
    }
    const popped: number[] = [];
    while (h.size > 0) {
      popped.push(h.peekKey());
      h.pop();
    }
    expect(popped).toEqual([...keys].sort((a, b) => a - b));
  });

  it('is deterministic: equal keys pop in the same order for the same pushes', () => {
    const run = (): number[] => {
      const h = new MinHeap();
      for (let i = 0; i < 50; i++) h.push(i % 3, i);
      const out: number[] = [];
      while (h.size > 0) out.push(h.pop());
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('clear empties it for reuse', () => {
    const h = new MinHeap();
    h.push(1, 1);
    h.clear();
    expect(h.size).toBe(0);
    h.push(3, 3);
    expect(h.pop()).toBe(3);
  });

  it('throws on pop and peek of an empty heap', () => {
    const h = new MinHeap();
    expect(() => h.pop()).toThrow(/empty/);
    expect(() => h.peekKey()).toThrow(/empty/);
  });
});
