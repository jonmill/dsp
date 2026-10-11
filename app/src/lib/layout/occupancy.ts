// Occupancy: where placed buildings stand, for the layout solver.
//  - building against building: exact oriented-box overlap, found through a spatial hash so a test only meets the
//    buildings nearby;
//  - belt lattice points against buildings: a point is blocked when it lies inside a footprint grown by half a belt.
// A building's boxes are those of the geometry kernel (`buildingOBBs`). The solver only turns buildings by quarter
// turns, so the boxes of an item at a yaw are the same boxes everywhere, moved by the building's position: they are
// computed once per item and yaw and moved from there.
import type { GameDataIndex } from '../data';
import { BELT_HALF_WIDTH_TILES, buildingDef, buildingOBBs, obbOverlap, pointInOBBs } from '../geometry';
import type { OBB2, PlacedBuilding, Yaw } from '../geometry';

/** An axis-aligned rectangle in tiles. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Side of a spatial hash cell, in tiles: about two assemblers. */
const CELL = 8;
/** Offset and stride that fold a cell's (column, row) into one number; far cells may share a key, which is harmless. */
const CELL_OFFSET = 1 << 20;
const CELL_STRIDE = 1 << 21;

const cellKey = (ix: number, iy: number): number => (ix + CELL_OFFSET) * CELL_STRIDE + (iy + CELL_OFFSET);

/** The rectangle that bounds all of `obbs` in plan view. */
export function obbsBounds(obbs: readonly OBB2[]): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const o of obbs) {
    const c = Math.abs(Math.cos(o.angle));
    const s = Math.abs(Math.sin(o.angle));
    const ex = c * o.hx + s * o.hy;
    const ey = s * o.hx + c * o.hy;
    b.minX = Math.min(b.minX, o.cx - ex);
    b.maxX = Math.max(b.maxX, o.cx + ex);
    b.minY = Math.min(b.minY, o.cy - ey);
    b.maxY = Math.max(b.maxY, o.cy + ey);
  }
  return b;
}

/** A building in the index: its boxes, their bounds, and the cells it is listed in. */
interface Entry {
  id: number;
  obbs: OBB2[];
  box: Bounds;
  /** Cell range it is listed in (the box grown by half a belt, so a belt point's cell finds it). */
  cells: { x0: number; x1: number; y0: number; y1: number };
  /** Last query that visited it, so a building spanning several cells is tested once per query. */
  seen: number;
}

export class Occupancy {
  private readonly entries = new Map<number, Entry>();
  private readonly cells = new Map<number, Entry[]>();
  /** Boxes at the origin by item and yaw. */
  private readonly templates = new Map<number, { obbs: OBB2[]; bounds: Bounds }>();
  private queries = 0;
  private cachedBounds: Bounds | null = null;

  constructor(private readonly data: GameDataIndex) {}

  private template(itemId: number, yaw: Yaw): { obbs: OBB2[]; bounds: Bounds } {
    const turns = yaw / 90;
    if (turns !== 0 && turns !== 1 && turns !== 2 && turns !== 3) {
      throw new RangeError(`unsupported yaw ${String(yaw)} (expected 0, 90, 180 or 270)`);
    }
    const key = itemId * 4 + turns;
    let t = this.templates.get(key);
    if (!t) {
      const obbs = buildingOBBs({ id: 0, itemId, x: 0, y: 0, z: 0, yaw }, buildingDef(this.data, itemId));
      t = { obbs, bounds: obbsBounds(obbs) };
      this.templates.set(key, t);
    }
    return t;
  }

  /** The boxes `b` occupies: the same as `buildingOBBs`, found by moving the boxes of its item at its yaw. */
  obbsOf(b: PlacedBuilding): OBB2[] {
    return this.template(b.itemId, b.yaw).obbs.map((o) => ({
      cx: o.cx + b.x,
      cy: o.cy + b.y,
      hx: o.hx,
      hy: o.hy,
      angle: o.angle,
      zMin: o.zMin + b.z,
      zMax: o.zMax + b.z,
    }));
  }

  /** The plan-view rectangle that bounds an item's footprint at `yaw`, relative to the building's position. */
  footprintOf(itemId: number, yaw: Yaw): Bounds {
    return this.template(itemId, yaw).bounds;
  }

  /** Throws if `b.id` is already indexed, or the building is not in GameData. */
  addBuilding(b: PlacedBuilding): void {
    if (this.entries.has(b.id)) throw new Error(`occupancy: building ${b.id} is already indexed`);
    const obbs = this.obbsOf(b);
    const box = obbsBounds(obbs);
    const cells = {
      x0: Math.floor((box.minX - BELT_HALF_WIDTH_TILES) / CELL),
      x1: Math.floor((box.maxX + BELT_HALF_WIDTH_TILES) / CELL),
      y0: Math.floor((box.minY - BELT_HALF_WIDTH_TILES) / CELL),
      y1: Math.floor((box.maxY + BELT_HALF_WIDTH_TILES) / CELL),
    };
    const entry: Entry = { id: b.id, obbs, box, cells, seen: 0 };
    this.entries.set(b.id, entry);
    for (let ix = cells.x0; ix <= cells.x1; ix++) {
      for (let iy = cells.y0; iy <= cells.y1; iy++) {
        const key = cellKey(ix, iy);
        const list = this.cells.get(key);
        if (list) list.push(entry);
        else this.cells.set(key, [entry]);
      }
    }
    this.cachedBounds = null;
  }

  /** Takes a building out of the index; false if it was not there. */
  removeBuilding(id: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    const { x0, x1, y0, y1 } = entry.cells;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const key = cellKey(ix, iy);
        const list = this.cells.get(key);
        if (!list) continue;
        const at = list.indexOf(entry);
        if (at >= 0) {
          list[at] = list[list.length - 1];
          list.pop();
        }
        if (list.length === 0) this.cells.delete(key);
      }
    }
    this.cachedBounds = null;
    return true;
  }

  /**
   * Does `b` overlap an indexed building? The test is exact (box against box) when `margin` is 0. With a margin,
   * every footprint counts as grown by `margin` tiles on all sides, so two buildings collide when they stand closer
   * than `2 * margin` tiles. An indexed building with the id of `b`, or one in `ignore`, is not tested (the building
   * being moved does not collide with its old place).
   */
  buildingCollides(b: PlacedBuilding, margin = 0, ignore?: ReadonlySet<number>): boolean {
    if (!(margin >= 0)) throw new RangeError(`margin must be at least 0, got ${margin}`);
    const reach = 2 * margin;
    const mine = this.obbsOf(b).map((o) => ({ ...o, hx: o.hx + reach, hy: o.hy + reach }));
    const q = obbsBounds(mine);
    const stamp = ++this.queries;
    const x0 = Math.floor(q.minX / CELL);
    const x1 = Math.floor(q.maxX / CELL);
    const y0 = Math.floor(q.minY / CELL);
    const y1 = Math.floor(q.maxY / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const list = this.cells.get(cellKey(ix, iy));
        if (!list) continue;
        for (const e of list) {
          if (e.seen === stamp) continue;
          e.seen = stamp;
          if (e.id === b.id || ignore?.has(e.id)) continue;
          if (e.box.maxX <= q.minX || e.box.minX >= q.maxX || e.box.maxY <= q.minY || e.box.minY >= q.maxY) continue;
          for (const a of mine) for (const c of e.obbs) if (obbOverlap(a, c)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Is the lattice point (x, y) at height level z taken by a building, once every footprint is grown by half the
   * width of a belt? A point on the roof of a building is free (see `pointInOBBs`).
   */
  blockedForBelt(x: number, y: number, z: number): boolean {
    const list = this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!list) return false;
    const pad = BELT_HALF_WIDTH_TILES;
    for (const e of list) {
      const { box } = e;
      if (x < box.minX - pad || x > box.maxX + pad || y < box.minY - pad || y > box.maxY + pad) continue;
      if (pointInOBBs(x, y, z, e.obbs, pad)) return true;
    }
    return false;
  }

  /** The rectangle that bounds every indexed footprint; all zeros while nothing is indexed. */
  bounds(): Bounds {
    if (!this.cachedBounds) {
      const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const e of this.entries.values()) {
        b.minX = Math.min(b.minX, e.box.minX);
        b.minY = Math.min(b.minY, e.box.minY);
        b.maxX = Math.max(b.maxX, e.box.maxX);
        b.maxY = Math.max(b.maxY, e.box.maxY);
      }
      this.cachedBounds = this.entries.size > 0 ? b : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    return { ...this.cachedBounds };
  }
}
