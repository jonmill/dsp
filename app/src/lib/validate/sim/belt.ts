// Belt simulation: the cell-and-cargo model of `CargoPath` (MX §2.2, §2.3).
//
// A belt is a run of cells numbered from the head (index 0, where cargo enters) to the rear (the last cell, where
// sorters, stations and merges take cargo out). A cargo occupies `CARGO_LENGTH` (10) consecutive cells and moves
// toward the rear by up to `speed` cells per tick; it can compress against the cargo ahead to exactly 10-cell
// spacing and stops with its last cell on the belt's last cell. The game stores this as a byte per cell
// (`246..250, <4 bytes item/stack/inc>, 255`); here a cargo is one entry of two int32 arrays, kept sorted by the
// cell its first cell sits on. That is the same state with the empty cells left out, so the per-tick update walks
// only cargo that can still move, not the whole buffer, and allocates nothing.
//
// Cell conventions this port fixes where the game source is not at hand (the C1/C3 gaps in MX §10.2):
//  - A cargo's "position" `p` is the index of its first cell; it covers cells `p .. p+9` and its 250 marker is
//    on `p+4`. The lead position is `length - 10` (marker on `bufferLength - 6`).
//  - `tryPick(cell)` looks at the 5 cells `cell-2 .. cell+2`. Like the game, only a cargo's first five cells
//    (the `246..250` run) are visible to a window, so it finds a cargo whose `p` is in `cell-6 .. cell+2`.
//  - `tryInsert(cell)` centres the cargo on `cell` (nominal `p = cell - 5`) and may slide it up to 5 cells to
//    fit the free space ("squeeze"); it never moves other cargo.
//  - Merges insert the same way. The game shifts the merge index when two paths' update parity differs; paths
//    here update in a fixed order, so that shift is not modelled.
import { CARGO_LENGTH as GAME_CARGO_LENGTH, packCargo, packedInc, packedItem, packedStack, unpackCargo } from './cargo';
import type { Cargo } from './cargo';

// A local copy: reading an imported binding in the per-tick loop costs a property lookup in some module systems.
const CARGO_LENGTH = GAME_CARGO_LENGTH;

/** Half a cargo: where `tryInsert` centres it. */
const HALF_CARGO = CARGO_LENGTH >> 1;
/** How far `tryInsert` may slide a cargo from its nominal slot. */
const SQUEEZE = 5;
/** Cells a pick window covers on each side of its centre cell. */
const PICK_HALF = 2;
/** Cells of a cargo (counted from its first) that a pick window can see: the `246..250` run. */
const VISIBLE_CELLS = 5;

export class BeltSim {
  readonly length: number;
  readonly speed: number;
  /** Lead position: the first cell of a cargo stopped at the rear (`length - 10`; negative if the belt is too short). */
  private readonly maxPos: number;
  /** First cell of each cargo, ascending (index 0 is nearest the head). */
  private readonly pos: Int32Array;
  /** Packed cargo, parallel to `pos`. */
  private readonly packed: Int32Array;
  private count = 0;
  /** The `frozen` cargo nearest the rear are packed against the rear and each other, so they cannot move. */
  private frozen = 0;
  private out: BeltSim | null = null;
  private outCell = 0;

  constructor(lengthCells: number, speedCellsPerTick: number) {
    if (!Number.isInteger(lengthCells) || lengthCells < 0) throw new RangeError(`belt length ${lengthCells} must be a non-negative integer`);
    if (!Number.isInteger(speedCellsPerTick) || speedCellsPerTick < 1) {
      throw new RangeError(`belt speed ${speedCellsPerTick} must be a positive integer`);
    }
    this.length = lengthCells;
    this.speed = speedCellsPerTick;
    this.maxPos = lengthCells - CARGO_LENGTH;
    const capacity = Math.floor(lengthCells / CARGO_LENGTH);
    this.pos = new Int32Array(capacity);
    this.packed = new Int32Array(capacity);
  }

  cargoCount(): number {
    return this.count;
  }

  /** The most cargo the belt holds: its cells over the cargo length. */
  capacity(): number {
    return Math.floor(this.length / CARGO_LENGTH);
  }

  /** First cell of the cargo nearest the rear, or -1 on an empty belt. */
  leadCell(): number {
    return this.count === 0 ? -1 : this.pos[this.count - 1];
  }

  /** First cell of every cargo, head side first. Allocates; for tests and diagnostics. */
  cargoCells(): number[] {
    return Array.from(this.pos.subarray(0, this.count));
  }

  /**
   * Merge into `target` at `cellIndex`: whenever a cargo sits at the rear of this belt, `update` tries to insert it
   * into `target` around that cell and drops it from this belt on success. The target decides, so its own flow has
   * priority (MX §2.3).
   */
  setOutput(target: BeltSim, cellIndex: number): void {
    if (target === this) throw new Error('a belt cannot merge into itself');
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= target.length) {
      throw new RangeError(`merge cell ${cellIndex} outside the target belt (0..${target.length - 1})`);
    }
    this.out = target;
    this.outCell = cellIndex;
  }

  // mirrors: CargoPath.TryInsertItemAtHeadAndFillBlank
  /**
   * Put `c` on the first 10 cells, if the head is empty (`buffer[9] == 0`: no cargo starts before cell 10). This is
   * how stations write onto a belt (MX §2.2, §7).
   */
  tryInsertAtHead(c: Cargo): boolean {
    const packed = packCargo(c);
    if (this.maxPos < 0) return false;
    if (this.count > 0 && this.pos[0] < CARGO_LENGTH) return false;
    this.insertAt(0, 0, packed);
    return true;
  }

  // mirrors: CargoPath.TryInsertItem
  /** Put `c` on the belt centred on `cellIndex`, sliding it up to 5 cells if it must; false if no window fits. */
  tryInsert(cellIndex: number, c: Cargo): boolean {
    const packed = packCargo(c);
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= this.length) return false;
    return this.insertNear(cellIndex - HALF_CARGO, packed);
  }

  // mirrors: CargoPath.TryPickItem
  /**
   * Take the first cargo, head side first, that a 5-cell window centred on `cellIndex` can see and that passes the
   * filters: `filter` is an item id (0 = any) and `accept`, if given, must return true for the item.
   */
  tryPick(cellIndex: number, filter: number, accept?: (item: number) => boolean): Cargo | null {
    const lo = cellIndex - PICK_HALF - (VISIBLE_CELLS - 1);
    const hi = cellIndex + PICK_HALF;
    const pos = this.pos;
    for (let k = this.firstAtOrAfter(lo); k < this.count && pos[k] <= hi; k++) {
      const item = packedItem(this.packed[k]);
      if (filter !== 0 && item !== filter) continue;
      if (accept !== undefined && !accept(item)) continue;
      const c = unpackCargo(this.packed[k]);
      this.removeAt(k);
      return c;
    }
    return null;
  }

  // mirrors: CargoPath.TryPickItemAtRear
  /** Take the cargo stopped at the rear (the end of the path), if it passes the filters of `tryPick`. */
  tryPickRear(filter: number, accept?: (item: number) => boolean): Cargo | null {
    const k = this.count - 1;
    if (k < 0 || this.pos[k] !== this.maxPos) return null;
    const item = packedItem(this.packed[k]);
    if (filter !== 0 && item !== filter) return null;
    if (accept !== undefined && !accept(item)) return null;
    const c = unpackCargo(this.packed[k]);
    this.removeAt(k);
    return c;
  }

  /**
   * Copy the cargo whose 10 cells cover `cellIndex` into `out`; false if the cell is in a gap. Where a spray coater
   * looks for the cargo passing it. Allocates nothing (it reads the packed fields directly).
   */
  cargoAt(cellIndex: number, out: Cargo): boolean {
    const k = this.coveringAt(cellIndex);
    if (k < 0) return false;
    const packed = this.packed[k];
    out.item = packedItem(packed);
    out.stack = packedStack(packed);
    out.inc = packedInc(packed);
    return true;
  }

  /** Set the proliferator points of the cargo covering `cellIndex`, in place; false if the cell is in a gap. */
  setIncAt(cellIndex: number, inc: number): boolean {
    const k = this.coveringAt(cellIndex);
    if (k < 0) return false;
    const c = unpackCargo(this.packed[k]);
    c.inc = inc;
    this.packed[k] = packCargo(c);
    return true;
  }

  // mirrors: CargoPath.Update
  /**
   * One tick. First a cargo stopped at the rear tries to merge into the output belt; then cargo advances,
   * rear-most first, by `speed` cells or up to the cargo ahead (spacing 10) or the rear. A block packed against the
   * rear is skipped, like the game's `updateLen`.
   */
  update(): void {
    if (this.count === 0) return;
    const pos = this.pos;
    if (this.out !== null && pos[this.count - 1] === this.maxPos) {
      // The merge is part of CargoPath.Update: TryInsertCargo into the output path at outputIndex.
      if (this.out.insertNear(this.outCell - HALF_CARGO, this.packed[this.count - 1])) this.removeAt(this.count - 1);
    }
    let k = this.count - 1 - this.frozen;
    if (k < 0) return;
    let limit = this.frozen === 0 ? this.maxPos : pos[k + 1] - CARGO_LENGTH;
    let packedToRear = true;
    const speed = this.speed;
    for (; k >= 0; k--) {
      let p = pos[k] + speed;
      if (p >= limit) {
        p = limit;
        if (packedToRear) this.frozen++;
      } else {
        packedToRear = false;
      }
      pos[k] = p;
      limit = p - CARGO_LENGTH;
    }
  }

  /** Index of the cargo covering `cellIndex` (first cell in `cellIndex - 9 .. cellIndex`), or -1. */
  private coveringAt(cellIndex: number): number {
    const k = this.firstAtOrAfter(cellIndex - CARGO_LENGTH + 1);
    return k < this.count && this.pos[k] <= cellIndex ? k : -1;
  }

  /** Index of the first cargo whose position is at least `p`. */
  private firstAtOrAfter(p: number): number {
    const pos = this.pos;
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pos[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Insert a packed cargo whose first cell is as near `nominal` as the free space allows, within `SQUEEZE` cells
   * of it. Only the gap between the cargo before and after `nominal` can host it: any other gap is 10 or more
   * cells away.
   */
  private insertNear(nominal: number, packed: number): boolean {
    if (this.maxPos < 0) return false;
    const k = this.firstAtOrAfter(nominal);
    const free0 = k > 0 ? this.pos[k - 1] + CARGO_LENGTH : 0;
    const free1 = k < this.count ? this.pos[k] - CARGO_LENGTH : this.maxPos;
    const lo = Math.max(free0, nominal - SQUEEZE);
    const hi = Math.min(free1, nominal + SQUEEZE, this.maxPos);
    if (lo > hi) return false;
    this.insertAt(k, nominal < lo ? lo : nominal > hi ? hi : nominal, packed);
    return true;
  }

  private insertAt(k: number, p: number, packed: number): void {
    const n = this.count;
    if (k < n) {
      this.pos.copyWithin(k + 1, k, n);
      this.packed.copyWithin(k + 1, k, n);
    }
    this.pos[k] = p;
    this.packed[k] = packed;
    this.count = n + 1;
    // A new cargo always goes behind the packed block (a packed block has no gap), so `frozen` is unchanged.
  }

  private removeAt(k: number): void {
    const n = this.count;
    this.pos.copyWithin(k, k + 1, n);
    this.packed.copyWithin(k, k + 1, n);
    this.count = n - 1;
    // Cargo behind a removed packed cargo has room now; cargo ahead of it is still packed against the rear.
    if (k >= n - this.frozen) this.frozen = n - 1 - k;
  }
}
