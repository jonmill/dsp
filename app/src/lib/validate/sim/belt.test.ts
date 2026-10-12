import { describe, expect, it } from 'vitest';
import { BeltSim } from './belt';
import type { Cargo } from './cargo';

const cargo = (item = 1001, stack = 1, inc = 0): Cargo => ({ item, stack, inc });

/** A belt after `ticks` updates since a single cargo was put at its head. */
function beltWithCargoAfter(length: number, speed: number, ticks: number): BeltSim {
  const belt = new BeltSim(length, speed);
  expect(belt.tryInsertAtHead(cargo())).toBe(true);
  for (let i = 0; i < ticks; i++) belt.update();
  return belt;
}

describe('BeltSim movement', () => {
  it('carries a head-inserted cargo to the rear in ceil(90/1) ticks on a Mk.I belt of 100 cells, then stops', () => {
    const belt = new BeltSim(100, 1);
    expect(belt.tryInsertAtHead(cargo(1001, 1, 0))).toBe(true);
    for (let t = 1; t < 90; t++) {
      belt.update();
      expect(belt.leadCell()).toBe(t);
      expect(belt.tryPickRear(0)).toBeNull();
    }
    belt.update();
    expect(belt.leadCell()).toBe(90);
    expect(belt.tryPickRear(0)).toEqual({ item: 1001, stack: 1, inc: 0 });
    expect(belt.cargoCount()).toBe(0);
  });

  it('never moves a cargo past the end of the belt', () => {
    const belt = beltWithCargoAfter(100, 1, 90);
    for (let t = 0; t < 300; t++) {
      belt.update();
      expect(belt.leadCell()).toBe(90);
      expect(belt.cargoCount()).toBe(1);
    }
  });

  it('moves speed cells per tick and clamps on the last step (Mk.III, 103 cells)', () => {
    const belt = new BeltSim(103, 5);
    belt.tryInsertAtHead(cargo());
    for (let t = 1; t <= 18; t++) {
      belt.update();
      expect(belt.leadCell()).toBe(5 * t);
    }
    belt.update();
    expect(belt.leadCell()).toBe(93); // 103 - 10
    belt.update();
    expect(belt.leadCell()).toBe(93);
  });

  it('keeps cargo at least 10 cells apart and packs a backed-up belt to length/10 cargo', () => {
    for (const [length, speed] of [[100, 1], [100, 5], [105, 2]] as const) {
      const belt = new BeltSim(length, speed);
      for (let t = 0; t < 1000; t++) {
        belt.update();
        belt.tryInsertAtHead(cargo());
      }
      expect(belt.cargoCount()).toBe(Math.floor(length / 10));
      expect(belt.capacity()).toBe(belt.cargoCount()); // a packed belt holds what it can
      const cells = belt.cargoCells();
      for (let i = 1; i < cells.length; i++) expect(cells[i] - cells[i - 1]).toBe(10);
      expect(cells[cells.length - 1]).toBe(length - 10);
      expect(belt.tryInsertAtHead(cargo())).toBe(false);
    }
  });

  it('refuses a head insert while the first 10 cells are occupied', () => {
    const belt = new BeltSim(100, 1);
    expect(belt.tryInsertAtHead(cargo())).toBe(true);
    for (let t = 1; t < 10; t++) {
      belt.update();
      expect(belt.tryInsertAtHead(cargo())).toBe(false);
    }
    belt.update();
    expect(belt.tryInsertAtHead(cargo())).toBe(true);
    expect(belt.cargoCells()).toEqual([0, 10]);
  });

  it('refills a gap at the end at belt speed after the lead cargo is picked', () => {
    const belt = new BeltSim(100, 2);
    for (let t = 0; t < 400; t++) {
      belt.update();
      belt.tryInsertAtHead(cargo());
    }
    expect(belt.tryPickRear(0)).not.toBeNull();
    // The next cargo was 10 cells behind: 5 ticks at 2 cells/tick.
    for (let t = 1; t < 5; t++) {
      belt.update();
      expect(belt.tryPickRear(0)).toBeNull();
    }
    belt.update();
    expect(belt.tryPickRear(0)).not.toBeNull();
  });

  it('does nothing on a belt shorter than one cargo', () => {
    const belt = new BeltSim(8, 1);
    expect(belt.tryInsertAtHead(cargo())).toBe(false);
    expect(belt.tryInsert(4, cargo())).toBe(false);
    belt.update();
    expect(belt.cargoCount()).toBe(0);
  });

  it('rejects a non-positive or fractional speed and an invalid stack', () => {
    expect(() => new BeltSim(100, 0)).toThrow(RangeError);
    expect(() => new BeltSim(100, 1.5)).toThrow(RangeError);
    const belt = new BeltSim(100, 1);
    expect(() => belt.tryInsertAtHead(cargo(1001, 5))).toThrow(RangeError);
    expect(() => belt.tryInsertAtHead(cargo(1001, 0))).toThrow(RangeError);
  });
});

describe('BeltSim throughput', () => {
  /** Cargo per second picked at the rear over ticks [1000, 7000) when the head is refilled and the rear drained every tick. */
  function measure(speed: number): number {
    const belt = new BeltSim(100, speed);
    let picked = 0;
    for (let t = 0; t < 7000; t++) {
      belt.update();
      if (belt.tryPickRear(0) && t >= 1000) picked++;
      belt.tryInsertAtHead(cargo());
    }
    return picked / ((7000 - 1000) / 60);
  }

  it('is 6 cargo/s on Mk.I', () => {
    expect(measure(1)).toBeGreaterThan(6 * 0.98);
    expect(measure(1)).toBeLessThanOrEqual(6 * 1.02);
  });

  it('is 12 cargo/s on Mk.II', () => {
    expect(measure(2)).toBeGreaterThan(12 * 0.98);
    expect(measure(2)).toBeLessThanOrEqual(12 * 1.02);
  });

  it('is 30 cargo/s on Mk.III', () => {
    expect(measure(5)).toBeGreaterThan(30 * 0.98);
    expect(measure(5)).toBeLessThanOrEqual(30 * 1.02);
  });
});

describe('BeltSim.tryPick', () => {
  it('takes a cargo whose first five cells meet the 5-cell window centred on the cell', () => {
    // A cargo at cells 40..49 is pickable from cells 38..46: its first five cells (40..44) meet [c-2, c+2].
    const at = (cell: number) => beltWithCargoAfter(100, 1, 40).tryPick(cell, 0);
    expect(at(37)).toBeNull();
    expect(at(38)).toEqual({ item: 1001, stack: 1, inc: 0 });
    expect(at(46)).toEqual({ item: 1001, stack: 1, inc: 0 });
    expect(at(47)).toBeNull();
  });

  it('removes the picked cargo', () => {
    const belt = beltWithCargoAfter(100, 1, 40);
    expect(belt.tryPick(42, 0)).not.toBeNull();
    expect(belt.cargoCount()).toBe(0);
    expect(belt.tryPick(42, 0)).toBeNull();
  });

  it('with a filter only takes matching items', () => {
    const belt = new BeltSim(100, 1);
    belt.tryInsertAtHead(cargo(1002, 3, 7));
    for (let t = 0; t < 40; t++) belt.update();
    expect(belt.tryPick(42, 1001)).toBeNull();
    expect(belt.cargoCount()).toBe(1);
    expect(belt.tryPick(42, 1002)).toEqual({ item: 1002, stack: 3, inc: 7 });
    expect(belt.cargoCount()).toBe(0);
  });

  it('filter 0 takes any item; an accept predicate narrows it', () => {
    const belt = new BeltSim(100, 1);
    belt.tryInsertAtHead(cargo(1005));
    for (let t = 0; t < 40; t++) belt.update();
    expect(belt.tryPick(42, 0, (item) => item === 1006)).toBeNull();
    expect(belt.tryPick(42, 1005, (item) => item === 1006)).toBeNull();
    expect(belt.tryPick(42, 0, (item) => item === 1005)).toEqual({ item: 1005, stack: 1, inc: 0 });
  });

  it('picks at the rear only the lead cargo', () => {
    const belt = new BeltSim(100, 5);
    belt.tryInsertAtHead(cargo(1001));
    for (let t = 0; t < 2; t++) belt.update();
    belt.tryInsertAtHead(cargo(1002));
    for (let t = 0; t < 200; t++) belt.update();
    expect(belt.cargoCells()).toEqual([80, 90]);
    expect(belt.tryPickRear(1002)).toBeNull(); // the lead cargo is item 1001
    expect(belt.tryPickRear(1001)).toEqual({ item: 1001, stack: 1, inc: 0 });
    expect(belt.cargoCount()).toBe(1);
  });
});

describe('BeltSim.tryInsert', () => {
  it('centres the cargo on the cell: cells c-5 .. c+4', () => {
    const belt = new BeltSim(100, 1);
    expect(belt.tryInsert(50, cargo())).toBe(true);
    expect(belt.cargoCells()).toEqual([45]);
  });

  it('refuses when no 10-cell window within 5 cells of the nominal slot is free', () => {
    const belt = new BeltSim(100, 1);
    belt.tryInsert(50, cargo());
    expect(belt.tryInsert(50, cargo())).toBe(false);
    expect(belt.tryInsert(54, cargo())).toBe(false); // nominal 49: free windows start 6 cells away
    expect(belt.tryInsert(46, cargo())).toBe(false); // nominal 41: the free window ends 6 cells away
    expect(belt.cargoCount()).toBe(1);
  });

  it('squeezes the cargo up to 5 cells away from the nominal slot to fit the free space', () => {
    const belt = new BeltSim(100, 1);
    belt.tryInsert(50, cargo(1001)); // 45..54
    expect(belt.tryInsert(57, cargo(1002))).toBe(true); // nominal 52, free from 55
    expect(belt.cargoCells()).toEqual([45, 55]);
    expect(belt.tryInsert(42, cargo(1003))).toBe(true); // nominal 37, free up to 35 (45 - 10)
    expect(belt.cargoCells()).toEqual([35, 45, 55]);
    expect(belt.tryInsert(31, cargo(1004))).toBe(true); // nominal 26, free up to 25
    expect(belt.cargoCells()).toEqual([25, 35, 45, 55]);
  });

  it('refuses a free window that starts more than 5 cells from the nominal slot', () => {
    const belt = new BeltSim(100, 1);
    belt.tryInsert(45, cargo()); // 40..49
    belt.tryInsert(65, cargo()); // 60..69, leaving exactly one free window at 50..59
    expect(belt.cargoCells()).toEqual([40, 60]);
    expect(belt.tryInsert(61, cargo())).toBe(false); // nominal 56: 6 cells from the window
    expect(belt.tryInsert(60, cargo())).toBe(true); // nominal 55: 5 cells
    expect(belt.cargoCells()).toEqual([40, 50, 60]);
  });

  it('clamps to the ends of the belt and rejects cells outside it', () => {
    const belt = new BeltSim(100, 1);
    expect(belt.tryInsert(0, cargo())).toBe(true);
    expect(belt.tryInsert(99, cargo())).toBe(true);
    expect(belt.cargoCells()).toEqual([0, 90]);
    expect(belt.tryInsert(-1, cargo())).toBe(false);
    expect(belt.tryInsert(100, cargo())).toBe(false);
  });

  it('keeps cargo 10 cells apart when inserting between moving cargo', () => {
    const belt = new BeltSim(200, 5);
    for (let t = 0; t < 40; t++) {
      belt.update();
      belt.tryInsertAtHead(cargo(1000 + t));
      if (t % 7 === 0) belt.tryInsert(100, cargo(5000 + t));
      const cells = belt.cargoCells();
      for (let i = 1; i < cells.length; i++) expect(cells[i] - cells[i - 1]).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('BeltSim merge', () => {
  /** Belt A (50 cells) ends into belt B (100 cells) at cell 60, both Mk.I. */
  function mergePair() {
    const a = new BeltSim(50, 1);
    const b = new BeltSim(100, 1);
    a.setOutput(b, 60);
    return { a, b };
  }

  it('moves the cargo at the end of A into an empty B around the merge cell', () => {
    const { a, b } = mergePair();
    a.tryInsertAtHead(cargo(1001, 2, 3));
    for (let t = 0; t < 40; t++) {
      a.update();
      b.update();
    }
    expect(a.leadCell()).toBe(40);
    expect(b.cargoCount()).toBe(0);
    a.update(); // the cargo sat at the end; it transfers now
    expect(a.cargoCount()).toBe(0);
    expect(b.cargoCells()).toEqual([55]);
    b.update();
    expect(b.cargoCells()).toEqual([56]);
    expect(b.tryPick(60, 1001)).toEqual({ item: 1001, stack: 2, inc: 3 });
  });

  it('transfers only when a 10-cell gap is free at the merge cell', () => {
    const { a, b } = mergePair();
    a.tryInsertAtHead(cargo(1001));
    for (let t = 0; t < 40; t++) a.update(); // now at A's end, B is still empty
    expect(a.leadCell()).toBe(40);
    // A straight-belt cargo passes the merge cell. Cargo at q blocks a slot in [50, 60] for q in [51, 59].
    b.tryInsertAtHead(cargo(2002));
    for (let t = 0; t < 51; t++) b.update();
    expect(b.cargoCells()).toEqual([51]);
    for (let q = 51; q < 60; q++) {
      a.update();
      expect(a.cargoCount()).toBe(1);
      expect(b.cargoCount()).toBe(1);
      b.update();
    }
    expect(b.cargoCells()).toEqual([60]);
    a.update();
    expect(a.cargoCount()).toBe(0);
    expect(b.cargoCells()).toEqual([50, 60]);
  });

  it('never merges into a backed-up belt, and the straight belt keeps priority', () => {
    const { a, b } = mergePair();
    for (let t = 0; t < 300; t++) {
      b.update();
      b.tryInsertAtHead(cargo(2002));
    }
    expect(b.cargoCount()).toBe(10);
    a.tryInsertAtHead(cargo(1001));
    for (let t = 0; t < 300; t++) a.update();
    expect(a.cargoCount()).toBe(1);
    expect(b.cargoCount()).toBe(10);
    // Draining B's rear opens no gap at the merge cell while the block shifts together.
    for (let t = 0; t < 30; t++) {
      b.update();
      b.tryPickRear(0);
      a.update();
    }
    expect(a.cargoCount()).toBe(1);
  });

  it('merges once B drains enough to leave a free window at the merge cell', () => {
    const { a, b } = mergePair();
    for (let t = 0; t < 300; t++) {
      b.update();
      b.tryInsertAtHead(cargo(2002));
    }
    a.tryInsertAtHead(cargo(1001));
    for (let t = 0; t < 100; t++) a.update();
    let merged = false;
    for (let t = 0; t < 400 && !merged; t++) {
      b.update();
      b.tryPickRear(0);
      const before = b.cargoCount();
      a.update();
      if (a.cargoCount() === 0) {
        merged = true;
        expect(b.cargoCount()).toBe(before + 1);
      }
    }
    expect(merged).toBe(true);
  });

  it('rejects a belt merging into itself', () => {
    const a = new BeltSim(50, 1);
    expect(() => a.setOutput(a, 10)).toThrow(/itself/);
  });
});

/**
 * A deliberately naive model of the same cells: a list of cargo, brute-force searches over every candidate cell,
 * no packed-block shortcut. The fuzz test below drives it and `BeltSim` with the same operations.
 */
class ReferenceBelt {
  cargos: { p: number; c: Cargo }[] = [];
  out: ReferenceBelt | null = null;
  outCell = 0;
  constructor(
    readonly length: number,
    readonly speed: number,
  ) {}
  get maxPos(): number {
    return this.length - 10;
  }
  fits(p: number): boolean {
    return p >= 0 && p <= this.maxPos && this.cargos.every((x) => Math.abs(x.p - p) >= 10);
  }
  place(p: number, c: Cargo): void {
    this.cargos.push({ p, c: { ...c } });
    this.cargos.sort((a, b) => a.p - b.p);
  }
  insertNear(nominal: number, c: Cargo): boolean {
    for (let d = 0; d <= 5; d++) {
      for (const p of d === 0 ? [nominal] : [nominal - d, nominal + d]) {
        if (this.fits(p)) {
          this.place(p, c);
          return true;
        }
      }
    }
    return false;
  }
  tryInsertAtHead(c: Cargo): boolean {
    if (!this.fits(0)) return false;
    this.place(0, c);
    return true;
  }
  tryInsert(cell: number, c: Cargo): boolean {
    return cell >= 0 && cell < this.length && this.insertNear(cell - 5, c);
  }
  tryPick(cell: number, filter: number): Cargo | null {
    for (let i = 0; i < this.cargos.length; i++) {
      const { p, c } = this.cargos[i];
      // A window of cells cell-2..cell+2 sees a cargo's first five cells p..p+4.
      const sees = p + 4 >= cell - 2 && p <= cell + 2;
      if (sees && (filter === 0 || c.item === filter)) {
        this.cargos.splice(i, 1);
        return c;
      }
    }
    return null;
  }
  tryPickRear(filter: number): Cargo | null {
    const last = this.cargos[this.cargos.length - 1];
    if (!last || last.p !== this.maxPos || (filter !== 0 && last.c.item !== filter)) return null;
    this.cargos.pop();
    return last.c;
  }
  update(): void {
    const last = this.cargos[this.cargos.length - 1];
    if (this.out && last && last.p === this.maxPos && this.out.insertNear(this.outCell - 5, last.c)) this.cargos.pop();
    for (let k = this.cargos.length - 1; k >= 0; k--) {
      const limit = k === this.cargos.length - 1 ? this.maxPos : this.cargos[k + 1].p - 10;
      this.cargos[k].p = Math.min(this.cargos[k].p + this.speed, limit);
    }
  }
  cells(): number[] {
    return this.cargos.map((x) => x.p);
  }
}

/** A small deterministic generator, so a failing seed reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('BeltSim against a naive cell model', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`agrees on every operation of a random run (seed ${seed})`, () => {
      const rand = lcg(seed);
      const int = (n: number) => Math.floor(rand() * n);
      const speed = [1, 2, 5][int(3)];
      const length = 30 + int(150);
      const belts = [new BeltSim(length, speed), new BeltSim(length + 40, speed)];
      const refs = [new ReferenceBelt(length, speed), new ReferenceBelt(length + 40, speed)];
      const mergeCell = 20 + int(length);
      belts[0].setOutput(belts[1], mergeCell);
      refs[0].out = refs[1];
      refs[0].outCell = mergeCell;
      const randomCargo = (): Cargo => ({ item: 1001 + int(3), stack: 1 + int(4), inc: int(40) });
      for (let step = 0; step < 4000; step++) {
        const which = int(2);
        const belt = belts[which];
        const ref = refs[which];
        const op = int(10);
        if (op < 4) {
          for (const i of [0, 1]) {
            belts[i].update();
            refs[i].update();
          }
        } else if (op < 6) {
          const c = randomCargo();
          expect(belt.tryInsertAtHead(c)).toBe(ref.tryInsertAtHead(c));
        } else if (op < 7) {
          const c = randomCargo();
          const cell = int(belt.length + 4) - 2;
          expect(belt.tryInsert(cell, c)).toBe(ref.tryInsert(cell, c));
        } else if (op < 8) {
          const cell = int(belt.length);
          const filter = int(4) === 0 ? 1001 + int(3) : 0;
          expect(belt.tryPick(cell, filter)).toEqual(ref.tryPick(cell, filter));
        } else {
          const filter = int(3) === 0 ? 1001 + int(3) : 0;
          expect(belt.tryPickRear(filter)).toEqual(ref.tryPickRear(filter));
        }
        expect(belts[0].cargoCells()).toEqual(refs[0].cells());
        expect(belts[1].cargoCells()).toEqual(refs[1].cells());
      }
    });
  }
});

describe('BeltSim cargoAt / setIncAt (spray coaters)', () => {
  it('finds the cargo whose 10 cells cover the cell, and none for a gap', () => {
    const belt = new BeltSim(100, 1);
    expect(belt.tryInsert(25, cargo(1001, 2, 0))).toBe(true); // first cell 20, covers 20..29
    const out: Cargo = { item: 0, stack: 0, inc: 0 };
    expect(belt.cargoAt(19, out)).toBe(false);
    expect(belt.cargoAt(20, out)).toBe(true);
    expect(out).toEqual({ item: 1001, stack: 2, inc: 0 });
    expect(belt.cargoAt(29, out)).toBe(true);
    expect(belt.cargoAt(30, out)).toBe(false);
    expect(belt.cargoAt(-1, out)).toBe(false);
    expect(belt.cargoAt(100, out)).toBe(false);
  });

  it('picks the right cargo among neighbours', () => {
    const belt = new BeltSim(100, 1);
    expect(belt.tryInsert(15, cargo(1001))).toBe(true); // 10..19
    expect(belt.tryInsert(25, cargo(1002))).toBe(true); // 20..29
    const out: Cargo = { item: 0, stack: 0, inc: 0 };
    expect(belt.cargoAt(19, out) && out.item).toBe(1001);
    expect(belt.cargoAt(20, out) && out.item).toBe(1002);
  });

  it('sets the proliferator points of that cargo in place, leaving positions alone', () => {
    const belt = new BeltSim(100, 1);
    expect(belt.tryInsert(15, cargo(1001, 3, 0))).toBe(true);
    expect(belt.tryInsert(25, cargo(1002, 1, 0))).toBe(true);
    const cells = belt.cargoCells();
    expect(belt.setIncAt(12, 12)).toBe(true);
    expect(belt.setIncAt(40, 4)).toBe(false);
    expect(belt.cargoCells()).toEqual(cells);
    const out: Cargo = { item: 0, stack: 0, inc: 0 };
    belt.cargoAt(12, out);
    expect(out).toEqual({ item: 1001, stack: 3, inc: 12 });
    belt.cargoAt(25, out);
    expect(out.inc).toBe(0);
    // The marked cargo still comes out of the rear with its points.
    for (let t = 0; t < 200; t++) belt.update();
    expect(belt.tryPickRear(0)).toEqual({ item: 1002, stack: 1, inc: 0 });
    expect(belt.tryPick(80, 0)).toEqual({ item: 1001, stack: 3, inc: 12 });
  });
});
