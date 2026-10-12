/**
 * The layout preview, apart from the canvas element: what to draw (`renderLayout`), what is under the cursor
 * (`hitTest`) and the view arithmetic (fit, zoom). Everything takes a 2D context or plain numbers, so it is tested
 * with a context that records its calls and no DOM.
 *
 * Grid space has x east and y north, in tiles; the canvas has y down. A view is `scale` canvas pixels per tile
 * and `origin`, the canvas position of grid (0, 0). North is up on screen.
 *
 * Levels. `level` is 'all' or a whole height level L, which shows what touches the band [L, L + 1): a belt node or
 * sorter end whose z is in it, a building collider that overlaps it. A collider's roof (`zMax`) is the first level
 * above it, so a belt lying on a roof is not hidden by the building under it.
 */
import type { BuildingKind, GameDataIndex } from '../lib/data';
import { BELT_HALF_WIDTH_TILES, buildingDef, buildingOBBs, layoutIndex, prefabToGrid, sorterEnds, TILE } from '../lib/geometry';
import type { BeltPath, GridPoint, Layout, OBB2, PlacedBuilding, Sorter } from '../lib/geometry';
import { pointInOBBs } from '../lib/geometry';
import type { Violation, ViolationEntity } from '../lib/validate';
import { buildingName, formatRate, itemName } from './format';

/** The part of the canvas 2D context the preview draws with. */
export type Draw2D = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'translate'
  | 'rotate'
  | 'beginPath'
  | 'rect'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'fill'
  | 'stroke'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineJoin'
  | 'lineCap'
>;

/** Where grid (0, 0) is on the canvas, and how many canvas pixels a tile is. */
export interface View {
  scale: number;
  origin: { x: number; y: number };
}

export interface RenderOptions {
  level: number | 'all';
  /** Canvas pixels per tile. */
  scale: number;
  /** Canvas position of grid (0, 0). Default (0, 0). */
  origin?: { x: number; y: number };
  /** Entities drawn in red on top of everything, whatever the level. */
  highlight?: Violation[];
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Smallest and largest scale, in pixels per tile, that `fitView` and `zoomAt` give. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 60;

export const VIOLATION_COLOR = '#e5322d';
const VIOLATION_FILL = 'rgba(229, 50, 45, 0.25)';
const SORTER_COLOR = '#8c97aa';
const LEVEL_EPS = 1e-6;
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// Colours

/** A colour per item id, spread round the hue wheel by the golden angle so neighbouring ids differ. */
export function beltColor(itemId: number): string {
  if (itemId === 0) return 'hsl(215 10% 55%)';
  return `hsl(${Math.round((itemId * 137.508) % 360)} 72% 50%)`;
}

const KIND_HUE: Record<BuildingKind, number> = {
  production: 210,
  lab: 275,
  belt: 0,
  sorter: 40,
  splitter: 40,
  station: 28,
  powerNode: 50,
  sprayCoater: 150,
  piler: 330,
  storage: 190,
  fractionator: 170,
  other: 215,
};

function buildingFill(kind: BuildingKind): string {
  return `hsla(${KIND_HUE[kind]}, 60%, 55%, 0.38)`;
}

function buildingStroke(kind: BuildingKind): string {
  return `hsl(${KIND_HUE[kind]}, 60%, 48%)`;
}

// ---------------------------------------------------------------------------------------------
// Which levels an entity is on

const onLevel = (z: number, level: number | 'all'): boolean => level === 'all' || Math.floor(z + LEVEL_EPS) === level;

const spansLevel = (box: OBB2, level: number | 'all'): boolean =>
  level === 'all' || (box.zMin < level + 1 - LEVEL_EPS && box.zMax > level + LEVEL_EPS);

/** The colliders of `b` and its definition, or null where GameData does not know the building. */
function boxesOf(b: PlacedBuilding, data: GameDataIndex): OBB2[] | null {
  const def = data.building(b.itemId);
  return def ? buildingOBBs(b, def) : null;
}

/** The two ends of a sorter, or null where the layout cannot place them (a missing building or belt). */
function endsOf(s: Sorter, layout: Layout, data: GameDataIndex): { pick: GridPoint; drop: GridPoint } | null {
  try {
    return sorterEnds(s, layout, data, layoutIndex(layout));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing

const toX = (x: number, opts: RenderOptions): number => (opts.origin?.x ?? 0) + x * opts.scale;
const toY = (y: number, opts: RenderOptions): number => (opts.origin?.y ?? 0) - y * opts.scale;

/** Adds the boxes to the current path as rotated rectangles. */
function addBoxes(ctx: Draw2D, boxes: OBB2[], opts: RenderOptions): void {
  for (const box of boxes) {
    ctx.save();
    ctx.translate(toX(box.cx, opts), toY(box.cy, opts));
    ctx.rotate(-box.angle);
    ctx.rect(-box.hx * opts.scale, -box.hy * opts.scale, 2 * box.hx * opts.scale, 2 * box.hy * opts.scale);
    ctx.restore();
  }
}

function drawPowerCover(ctx: Draw2D, b: PlacedBuilding, data: GameDataIndex, opts: RenderOptions): void {
  const node = data.building(b.itemId)?.power.node;
  if (!node || node.coverRadius <= 0) return;
  const at = prefabToGrid(b, node.powerPoint);
  const x = toX(at.x, opts);
  const y = toY(at.y, opts);
  ctx.fillStyle = 'rgba(240, 190, 40, 0.07)';
  ctx.strokeStyle = 'rgba(240, 190, 40, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, (node.coverRadius / TILE) * opts.scale, 0, TWO_PI);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(240, 190, 40, 0.9)';
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, TWO_PI);
  ctx.fill();
}

function drawBelt(ctx: Draw2D, belt: BeltPath, opts: RenderOptions): void {
  const { nodes } = belt;
  if (nodes.length === 0) return;
  ctx.strokeStyle = beltColor(belt.itemId);
  ctx.lineWidth = Math.max(1.5, 2 * BELT_HALF_WIDTH_TILES * opts.scale * 0.8);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let drawn = false;
  let pen = false;
  const last = nodes.length === 1 ? 1 : nodes.length - 1;
  for (let i = 0; i < last; i++) {
    const a = nodes[i];
    const b = nodes[i + 1] ?? a;
    if (!onLevel(a.z, opts.level) && !onLevel(b.z, opts.level)) {
      pen = false;
      continue;
    }
    if (!pen) ctx.moveTo(toX(a.x, opts), toY(a.y, opts));
    ctx.lineTo(toX(b.x, opts), toY(b.y, opts));
    pen = true;
    drawn = true;
  }
  if (drawn) ctx.stroke();
}

/** Adds a sorter as a shaft with an arrow head at its drop end. */
function addSorterArrow(ctx: Draw2D, ends: { pick: GridPoint; drop: GridPoint }, opts: RenderOptions): void {
  const x0 = toX(ends.pick.x, opts);
  const y0 = toY(ends.pick.y, opts);
  const x1 = toX(ends.drop.x, opts);
  const y1 = toY(ends.drop.y, opts);
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (length < 1e-6) return;
  const head = Math.min(Math.max(4, opts.scale * 0.4), length * 0.6);
  const ux = (x1 - x0) / length;
  const uy = (y1 - y0) / length;
  ctx.moveTo(x1 - head * (ux * 0.87 - uy * 0.5), y1 - head * (uy * 0.87 + ux * 0.5));
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 - head * (ux * 0.87 + uy * 0.5), y1 - head * (uy * 0.87 - ux * 0.5));
}

function drawSorter(ctx: Draw2D, s: Sorter, layout: Layout, data: GameDataIndex, opts: RenderOptions): void {
  const ends = endsOf(s, layout, data);
  if (!ends || (!onLevel(ends.pick.z, opts.level) && !onLevel(ends.drop.z, opts.level))) return;
  ctx.strokeStyle = s.filterItemId === 0 ? SORTER_COLOR : beltColor(s.filterItemId);
  ctx.lineWidth = Math.max(1.5, opts.scale * 0.2);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  addSorterArrow(ctx, ends, opts);
  ctx.stroke();
}

function drawViolation(ctx: Draw2D, entity: ViolationEntity, layout: Layout, data: GameDataIndex, opts: RenderOptions): void {
  ctx.strokeStyle = VIOLATION_COLOR;
  ctx.fillStyle = VIOLATION_FILL;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (entity.kind === 'building') {
    const b = layout.buildings.find((x) => x.id === entity.id);
    const boxes = b && boxesOf(b, data);
    if (!boxes) return;
    ctx.beginPath();
    addBoxes(ctx, boxes, opts);
    ctx.fill();
    ctx.stroke();
  } else if (entity.kind === 'belt') {
    const belt = layout.belts.find((x) => x.id === entity.id);
    if (!belt || belt.nodes.length === 0) return;
    ctx.beginPath();
    const at = entity.node === undefined ? undefined : belt.nodes[entity.node];
    if (at) {
      ctx.arc(toX(at.x, opts), toY(at.y, opts), Math.max(6, opts.scale * 0.9), 0, TWO_PI);
    } else {
      belt.nodes.forEach((n, i) => {
        if (i === 0) ctx.moveTo(toX(n.x, opts), toY(n.y, opts));
        else ctx.lineTo(toX(n.x, opts), toY(n.y, opts));
      });
    }
    ctx.stroke();
  } else {
    const sorter = layout.sorters.find((x) => x.id === entity.id);
    const ends = sorter && endsOf(sorter, layout, data);
    if (!ends) return;
    ctx.beginPath();
    addSorterArrow(ctx, ends, opts);
    ctx.stroke();
  }
}

/**
 * Draws `layout` on `ctx`. Power cover circles first (low alpha, under everything), then buildings (one rect per
 * collider, filled by kind), belts (one path each, coloured by item), sorters (one arrow each), then the
 * `highlight`ed violations in red.
 */
export function renderLayout(ctx: Draw2D, layout: Layout, data: GameDataIndex, opts: RenderOptions): void {
  const shown: { b: PlacedBuilding; kind: BuildingKind; boxes: OBB2[] }[] = [];
  for (const b of layout.buildings) {
    const boxes = boxesOf(b, data)?.filter((box) => spansLevel(box, opts.level));
    if (boxes && boxes.length > 0) shown.push({ b, kind: buildingDef(data, b.itemId).kind, boxes });
  }
  shown.sort((p, q) => Math.min(...p.boxes.map((x) => x.zMin)) - Math.min(...q.boxes.map((x) => x.zMin)));

  for (const { b } of shown) drawPowerCover(ctx, b, data, opts);

  ctx.lineJoin = 'miter';
  ctx.lineWidth = 1;
  for (const { kind, boxes } of shown) {
    ctx.fillStyle = buildingFill(kind);
    ctx.strokeStyle = buildingStroke(kind);
    ctx.beginPath();
    addBoxes(ctx, boxes, opts);
    ctx.fill();
    ctx.stroke();
  }

  const lowest = (belt: BeltPath): number => belt.nodes.reduce((z, n) => Math.min(z, n.z), Infinity);
  for (const belt of [...layout.belts].sort((p, q) => lowest(p) - lowest(q))) drawBelt(ctx, belt, opts);
  for (const s of layout.sorters) drawSorter(ctx, s, layout, data, opts);

  for (const violation of opts.highlight ?? []) {
    for (const entity of violation.entities) drawViolation(ctx, entity, layout, data, opts);
  }
}

// ---------------------------------------------------------------------------------------------
// Hit testing

export interface HitOptions {
  level?: number | 'all';
  /** Extra reach, in tiles, around every entity. Default 0. */
  tolerance?: number;
}

/** A sorter is hit within this many tiles of its shaft. */
const SORTER_REACH = 0.3;

function distanceToSegment(px: number, py: number, a: GridPoint, b: GridPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / lengthSq));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/**
 * The entity under the grid point `(x, y)`: a sorter first, then a belt (with the node nearest the point), then a
 * building. Of several of one kind the highest wins (it is drawn on top), then the nearest. Null over empty ground.
 */
export function hitTest(layout: Layout, data: GameDataIndex, x: number, y: number, opts: HitOptions = {}): ViolationEntity | null {
  const level = opts.level ?? 'all';
  const tolerance = opts.tolerance ?? 0;

  let sorter: { id: number; z: number; d: number } | undefined;
  for (const s of layout.sorters) {
    const ends = endsOf(s, layout, data);
    if (!ends || (!onLevel(ends.pick.z, level) && !onLevel(ends.drop.z, level))) continue;
    const d = distanceToSegment(x, y, ends.pick, ends.drop);
    const z = Math.max(ends.pick.z, ends.drop.z);
    if (d > SORTER_REACH + tolerance || (sorter && (z < sorter.z || (z === sorter.z && d >= sorter.d)))) continue;
    sorter = { id: s.id, z, d };
  }
  if (sorter) return { kind: 'sorter', id: sorter.id };

  let belt: { id: number; node: number; z: number; d: number } | undefined;
  for (const b of layout.belts) {
    const nodes = b.nodes;
    for (let i = 0; i < Math.max(1, nodes.length - 1); i++) {
      const a = nodes[i];
      const c = nodes[i + 1] ?? a;
      if (!a || (!onLevel(a.z, level) && !onLevel(c.z, level))) continue;
      const d = distanceToSegment(x, y, a, c);
      const near = Math.hypot(x - a.x, y - a.y) <= Math.hypot(x - c.x, y - c.y) ? i : Math.min(i + 1, nodes.length - 1);
      const z = nodes[near].z;
      if (d > BELT_HALF_WIDTH_TILES + tolerance || (belt && (z < belt.z || (z === belt.z && d >= belt.d)))) continue;
      belt = { id: b.id, node: near, z, d };
    }
  }
  if (belt) return { kind: 'belt', id: belt.id, node: belt.node };

  let building: { id: number; z: number; d: number } | undefined;
  for (const b of layout.buildings) {
    const boxes = boxesOf(b, data)?.filter((box) => spansLevel(box, level));
    if (!boxes || !pointInOBBs(x, y, null, boxes, tolerance)) continue;
    const d = Math.hypot(x - b.x, y - b.y);
    if (building && (b.z < building.z || (b.z === building.z && d >= building.d))) continue;
    building = { id: b.id, z: b.z, d };
  }
  return building ? { kind: 'building', id: building.id } : null;
}

// ---------------------------------------------------------------------------------------------
// Tooltips and where things are

const place = (x: number, y: number, z: number): string => `(${+x.toFixed(1)}, ${+y.toFixed(1)}) level ${+z.toFixed(1)}`;

/** A few lines of text for the tooltip over `entity`: what it is, what it does and where it is. */
export function describeEntity(layout: Layout, data: GameDataIndex, entity: ViolationEntity): string {
  if (entity.kind === 'building') {
    const b = layout.buildings.find((x) => x.id === entity.id);
    if (!b) return `building #${entity.id} is not in the layout`;
    const lines = [`${buildingName(data, b.itemId)} #${b.id}`];
    if (b.recipeId !== undefined) {
      let recipe = `recipe ${b.recipeId}`;
      try {
        recipe = data.recipe(b.recipeId).name;
      } catch {
        // an unknown recipe id is shown by its number
      }
      lines.push(recipe);
    }
    if (b.station) lines.push(`${b.station.slots.length} item slot${b.station.slots.length === 1 ? '' : 's'}`);
    if (b.role) lines.push(`role ${b.role}`);
    lines.push(place(b.x, b.y, b.z));
    return lines.join('\n');
  }
  if (entity.kind === 'belt') {
    const belt = layout.belts.find((x) => x.id === entity.id);
    if (!belt) return `belt #${entity.id} is not in the layout`;
    const lines = [`${buildingName(data, belt.tierItemId)} #${belt.id}`, `carries ${itemName(data, belt.itemId)}`];
    const at = entity.node === undefined ? undefined : belt.nodes[entity.node];
    if (at) lines.push(`node ${entity.node} of ${belt.nodes.length}: ${place(at.x, at.y, at.z)}`);
    lines.push(`planned ${formatRate(belt.plannedRate, 's')}`);
    return lines.join('\n');
  }
  const s = layout.sorters.find((x) => x.id === entity.id);
  if (!s) return `sorter #${entity.id} is not in the layout`;
  return [
    `${buildingName(data, s.tierItemId)} #${s.id}`,
    s.filterItemId === 0 ? 'any item' : itemName(data, s.filterItemId),
    `span ${s.span}, planned ${formatRate(s.plannedRate, 's')}`,
  ].join('\n');
}

/** The grid point at the middle of `entity` (a belt node's own point), or null where the layout does not have it. */
export function entityCentre(layout: Layout, data: GameDataIndex, entity: ViolationEntity): { x: number; y: number } | null {
  if (entity.kind === 'building') {
    const b = layout.buildings.find((x) => x.id === entity.id);
    return b ? { x: b.x, y: b.y } : null;
  }
  if (entity.kind === 'belt') {
    const belt = layout.belts.find((x) => x.id === entity.id);
    const at = belt && (entity.node === undefined ? belt.nodes[Math.floor(belt.nodes.length / 2)] : belt.nodes[entity.node]);
    return at ? { x: at.x, y: at.y } : null;
  }
  const s = layout.sorters.find((x) => x.id === entity.id);
  const ends = s && endsOf(s, layout, data);
  return ends ? { x: (ends.pick.x + ends.drop.x) / 2, y: (ends.pick.y + ends.drop.y) / 2 } : null;
}

// ---------------------------------------------------------------------------------------------
// The view

/** The box around every collider, belt node and sorter end; null for an empty layout. */
export function layoutBounds(layout: Layout, data: GameDataIndex): Bounds | null {
  let box: Bounds | null = null;
  const add = (minX: number, maxX: number, minY: number, maxY: number): void => {
    box = box
      ? { minX: Math.min(box.minX, minX), maxX: Math.max(box.maxX, maxX), minY: Math.min(box.minY, minY), maxY: Math.max(box.maxY, maxY) }
      : { minX, maxX, minY, maxY };
  };
  for (const b of layout.buildings) {
    for (const o of boxesOf(b, data) ?? []) {
      const c = Math.abs(Math.cos(o.angle));
      const s = Math.abs(Math.sin(o.angle));
      const ex = o.hx * c + o.hy * s;
      const ey = o.hx * s + o.hy * c;
      add(o.cx - ex, o.cx + ex, o.cy - ey, o.cy + ey);
    }
  }
  for (const belt of layout.belts) for (const n of belt.nodes) add(n.x, n.x, n.y, n.y);
  for (const s of layout.sorters) {
    const ends = endsOf(s, layout, data);
    if (!ends) continue;
    for (const p of [ends.pick, ends.drop]) add(p.x, p.x, p.y, p.y);
  }
  return box;
}

/** The highest height level that holds a building or a belt node; 0 for an empty layout. */
export function maxLevel(layout: Layout): number {
  let top = 0;
  for (const b of layout.buildings) top = Math.max(top, b.z);
  for (const belt of layout.belts) for (const n of belt.nodes) top = Math.max(top, n.z);
  return Math.round(top);
}

const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** The view that puts `bounds` in the middle of a `width` by `height` canvas, `padding` pixels from its edges. */
export function fitView(bounds: Bounds, width: number, height: number, padding = 24): View {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const scale = clampScale(Math.min(Math.max(width - 2 * padding, 1) / spanX, Math.max(height - 2 * padding, 1) / spanY));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { scale, origin: { x: width / 2 - cx * scale, y: height / 2 + cy * scale } };
}

/** The grid point under the canvas position `(sx, sy)`. */
export function screenToGrid(sx: number, sy: number, view: View): { x: number; y: number } {
  return { x: (sx - view.origin.x) / view.scale, y: (view.origin.y - sy) / view.scale };
}

/** `view` zoomed by `factor` about the canvas position `(sx, sy)`, which keeps the grid point under it. */
export function zoomAt(view: View, sx: number, sy: number, factor: number): View {
  const scale = clampScale(view.scale * factor);
  const at = screenToGrid(sx, sy, view);
  return { scale, origin: { x: sx - at.x * scale, y: sy + at.y * scale } };
}
