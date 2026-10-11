// A binary min-heap of (key, value) pairs for the router's A*: keys are doubles, values are integers (state indices).
// Two parallel typed arrays, no per-entry objects. Equal keys pop in an order that depends only on the pushes, so a
// search is reproducible.

export class MinHeap {
  private keys: Float64Array;
  private values: Int32Array;
  private n = 0;

  constructor(capacity = 1024) {
    const c = Math.max(2, capacity);
    this.keys = new Float64Array(c);
    this.values = new Int32Array(c);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  push(key: number, value: number): void {
    if (this.n === this.keys.length) this.grow();
    let i = this.n++;
    const keys = this.keys;
    const values = this.values;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  /** The smallest key. Throws when empty. */
  peekKey(): number {
    if (this.n === 0) throw new Error('MinHeap.peekKey: the heap is empty');
    return this.keys[0];
  }

  /** Removes the entry with the smallest key and returns its value. Throws when empty. */
  pop(): number {
    if (this.n === 0) throw new Error('MinHeap.pop: the heap is empty');
    const keys = this.keys;
    const values = this.values;
    const top = values[0];
    const n = --this.n;
    if (n > 0) {
      const key = keys[n];
      const value = values[n];
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = key;
      values[i] = value;
    }
    return top;
  }

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2);
    const values = new Int32Array(this.values.length * 2);
    keys.set(this.keys);
    values.set(this.values);
    this.keys = keys;
    this.values = values;
  }
}
