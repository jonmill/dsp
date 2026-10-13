import { describe, expect, it } from 'vitest';
import { buildingOBBs, layoutIndex, sorterEnds, TILE } from '../lib/geometry';
import type { Layout } from '../lib/geometry';
import { compositeLayout, fixtureData, ITEM, LayoutKit, line, onNode, onSlot } from '../lib/validate/testkit';
import type { Violation } from '../lib/validate';
import {
  beltColor,
  describeEntity,
  entityCentre,
  fitView,
  hitTest,
  layoutBounds,
  maxLevel,
  PAN_STEP,
  previewKeyAction,
  renderLayout,
  screenToGrid,
  VIOLATION_COLOR,
  ZOOM_STEP,
  zoomAt,
} from './preview';

interface Call {
  name: string;
  args: unknown[];
  /** The styles in force when the call was made. */
  strokeStyle: unknown;
  fillStyle: unknown;
}

/** A 2D context that records every call (and the styles in force) instead of drawing. */
function fakeContext() {
  const calls: Call[] = [];
  const props: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name in props
          ? props[name]
          : (...args: unknown[]) => {
              calls.push({ name, args, strokeStyle: props.strokeStyle, fillStyle: props.fillStyle });
            },
      set: (_target, name: string, value: unknown) => {
        props[name] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  const count = (name: string) => calls.filter((c) => c.name === name).length;
  return { ctx, calls, count };
}

const data = fixtureData;
const ALL = { level: 'all', scale: 10 } as const;

/** Two assemblers, a smelter and a station, joined by two belts of different items; no sorters, no power. */
function plainLayout(): Layout {
  const kit = new LayoutKit();
  kit.station(0, 0);
  kit.assembler(10, 10);
  kit.assembler(20, 10);
  kit.smelter(30, 10);
  kit.belt(1, 1001, line([0, 5], [12, 5]));
  kit.belt(2, 1101, [...line([20, 6], [20, 8]), ...line([21, 8], [25, 8], 1)]);
  return kit.layout();
}

describe('renderLayout', () => {
  it('draws one rect per building collider and one path per belt', () => {
    const layout = plainLayout();
    const { ctx, count } = fakeContext();
    renderLayout(ctx, layout, data, ALL);

    const colliders = layout.buildings.reduce((n, b) => n + buildingOBBs(b, data.building(b.itemId)!).length, 0);
    expect(count('rect')).toBe(colliders);
    // Three single-collider machines and one station of two: not one rect per building, one per collider.
    expect(colliders).toBe(5);
    // A belt is one path: a moveTo to its first node, then a lineTo for each next node. Nothing else here draws lines.
    expect(count('moveTo')).toBe(layout.belts.length);
    expect(count('lineTo')).toBe(layout.belts.reduce((n, b) => n + b.nodes.length - 1, 0));
  });

  it('draws one rect per building when every building has one collider', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    kit.assembler(5, 0);
    kit.smelter(10, 0);
    const { ctx, count } = fakeContext();
    renderLayout(ctx, kit.layout(), data, ALL);
    expect(count('rect')).toBe(3);
  });

  it('places a building by its centre, scale and origin, with the y axis pointing up', () => {
    const kit = new LayoutKit();
    kit.assembler(4, 3);
    const { ctx, calls } = fakeContext();
    renderLayout(ctx, kit.layout(), data, { level: 'all', scale: 10, origin: { x: 100, y: 200 } });
    const move = calls.find((c) => c.name === 'translate')!;
    expect(move.args[0]).toBeCloseTo(140, 6);
    expect(move.args[1]).toBeCloseTo(170, 6);
    const rect = calls.find((c) => c.name === 'rect')!;
    // The Mk.I assembler collider is 2 m either side of its centre.
    const half = (2 / TILE) * 10;
    expect(rect.args[2]).toBeCloseTo(2 * half, 6);
    expect(rect.args[3]).toBeCloseTo(2 * half, 6);
  });

  it('colours a belt by the item it carries, the same way each time', () => {
    const kit = new LayoutKit();
    kit.belt(1, 1001, line([0, 0], [4, 0]));
    kit.belt(1, 1101, line([0, 2], [4, 2]));
    const { ctx, calls } = fakeContext();
    renderLayout(ctx, kit.layout(), data, ALL);
    const strokes = calls.filter((c) => c.name === 'stroke').map((c) => c.strokeStyle);
    expect(strokes).toEqual([beltColor(1001), beltColor(1101)]);
    expect(beltColor(1001)).not.toBe(beltColor(1101));
    expect(beltColor(1001)).toBe(beltColor(1001));
  });

  it('draws a sorter as a short arrow in one stroke', () => {
    const kit = new LayoutKit();
    const asm = kit.assembler(0, 0);
    const belt = kit.belt(1, 1001, line([-2, 5], [4, 5]));
    kit.sorter(onNode(belt, 3), onSlot(asm, 7));
    const withSorter = fakeContext();
    renderLayout(withSorter.ctx, kit.layout(), data, ALL);

    const without = fakeContext();
    renderLayout(without.ctx, { ...kit.layout(), sorters: [] }, data, ALL);
    // The shaft and the two sides of the head: three more segments in one path.
    expect(withSorter.count('moveTo') - without.count('moveTo')).toBeGreaterThanOrEqual(1);
    expect(withSorter.count('stroke') - without.count('stroke')).toBe(1);
  });

  it('draws a power node as a circle with the cover radius at low alpha', () => {
    const kit = new LayoutKit();
    kit.tesla(5, 5);
    const { ctx, calls } = fakeContext();
    renderLayout(ctx, kit.layout(), data, ALL);
    const circle = calls.find((c) => c.name === 'arc' && (c.args[2] as number) > 20)!;
    const cover = data.building(ITEM.tesla)!.power.node!.coverRadius;
    expect(circle.args[2]).toBeCloseTo((cover / TILE) * 10, 6);
    expect(String(circle.fillStyle)).toMatch(/rgba?\(|hsla?\(.*\/|#[0-9a-f]{8}/i);
  });

  it('draws only the belts on the chosen level', () => {
    const layout = plainLayout();
    const ground = fakeContext();
    renderLayout(ground.ctx, layout, data, { level: 0, scale: 10 });
    // Belt 2 climbs to level 1; its first half is still on level 0, so both belts show.
    expect(ground.count('moveTo')).toBe(2);

    const up = fakeContext();
    renderLayout(up.ctx, layout, data, { level: 1, scale: 10 });
    // Only belt 2 reaches level 1.
    expect(up.count('moveTo')).toBe(1);

    const high = fakeContext();
    renderLayout(high.ctx, layout, data, { level: 7, scale: 10 });
    expect(high.count('moveTo')).toBe(0);
  });

  it('draws a building on every level its collider spans', () => {
    const kit = new LayoutKit();
    const low = kit.assembler(0, 0);
    kit.assembler(10, 0, 0, 1, 2303).z = 10;
    const layout = kit.layout();
    const [box] = buildingOBBs(low, data.building(low.itemId)!);
    const rects = (level: number | 'all') => {
      const { ctx, count } = fakeContext();
      renderLayout(ctx, layout, data, { level, scale: 10 });
      return count('rect');
    };
    expect(rects('all')).toBe(2);
    expect(rects(0)).toBe(1);
    // The low one is a few levels tall: it shows on every level up to its roof, and not on the roof level itself.
    expect(rects(Math.ceil(box.zMax) - 1)).toBe(1);
    expect(rects(Math.ceil(box.zMax))).toBe(0);
    expect(rects(10)).toBe(1);
    expect(rects(30)).toBe(0);
  });

  it('draws the highlighted violations in red, and only then', () => {
    const c = compositeLayout();
    const layout = c.kit.layout();
    const plain = fakeContext();
    renderLayout(plain.ctx, layout, data, ALL);
    expect(plain.calls.some((call) => call.strokeStyle === VIOLATION_COLOR)).toBe(false);

    const violations: Violation[] = [
      { code: 'BUILDING_OVERLAP', entities: [{ kind: 'building', id: c.asmA.id }], message: 'a' },
      { code: 'BELT_DISCONNECTED', entities: [{ kind: 'belt', id: c.belt.id, node: 4 }], message: 'b' },
      { code: 'SORTER_SPAN', entities: [{ kind: 'sorter', id: c.feedA.id }], message: 'c' },
    ];
    const marked = fakeContext();
    renderLayout(marked.ctx, layout, data, { ...ALL, highlight: violations });
    const red = marked.calls.filter((call) => call.name === 'stroke' && call.strokeStyle === VIOLATION_COLOR);
    // The building outline, the belt (a ring on the node), the sorter.
    expect(red.length).toBe(3);
  });

  it('survives an entity the layout cannot resolve', () => {
    const c = compositeLayout();
    const layout = c.kit.layout();
    layout.sorters.push({ ...c.feedA, id: 99, pick: { kind: 'building', buildingId: 12345, slot: 0 } });
    const { ctx } = fakeContext();
    expect(() => renderLayout(ctx, layout, data, ALL)).not.toThrow();
    expect(() => hitTest(layout, data, 0, 0)).not.toThrow();
    expect(layoutBounds(layout, data)).not.toBeNull();
  });
});

describe('hitTest', () => {
  it('returns the assembler at its centre', () => {
    const c = compositeLayout();
    const layout = c.kit.layout();
    expect(hitTest(layout, data, c.asmA.x, c.asmA.y)).toEqual({ kind: 'building', id: c.asmA.id });
    expect(hitTest(layout, data, c.asmB.x, c.asmB.y)).toEqual({ kind: 'building', id: c.asmB.id });
  });

  it('returns nothing over empty ground', () => {
    const layout = compositeLayout().kit.layout();
    expect(hitTest(layout, data, 60, 60)).toBeNull();
  });

  it('prefers a belt over the building it runs through, and names the nearest node', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    const belt = kit.belt(1, 1001, line([-3, 0], [3, 0], 2));
    const layout = kit.layout();
    expect(hitTest(layout, data, 2, 0.1)).toEqual({ kind: 'belt', id: belt.id, node: 5 });
  });

  it('prefers a sorter over the belt it ends on', () => {
    const c = compositeLayout();
    const layout = c.kit.layout();
    const ends = sorterEnds(c.feedA, layout, data, layoutIndex(layout));
    const middle = { x: (ends.pick.x + ends.drop.x) / 2, y: (ends.pick.y + ends.drop.y) / 2 };
    expect(hitTest(layout, data, middle.x, middle.y)).toEqual({ kind: 'sorter', id: c.feedA.id });
  });

  it('forgives a miss by the tolerance, in tiles', () => {
    const kit = new LayoutKit();
    const belt = kit.belt(1, 1001, line([0, 0], [6, 0]));
    const layout = kit.layout();
    expect(hitTest(layout, data, 3, 0.9)).toBeNull();
    expect(hitTest(layout, data, 3, 0.9, { tolerance: 1 })).toEqual({ kind: 'belt', id: belt.id, node: 3 });
  });

  it('only sees what is on the chosen level', () => {
    const kit = new LayoutKit();
    const lower = kit.belt(1, 1001, line([0, 0], [6, 0], 0));
    const upper = kit.belt(1, 1101, line([0, 0], [6, 0], 3));
    const layout = kit.layout();
    expect(hitTest(layout, data, 3, 0, { level: 0 })).toEqual({ kind: 'belt', id: lower.id, node: 3 });
    expect(hitTest(layout, data, 3, 0, { level: 3 })).toEqual({ kind: 'belt', id: upper.id, node: 3 });
    expect(hitTest(layout, data, 3, 0, { level: 1 })).toBeNull();
    // With every level shown, the highest one is on top.
    expect(hitTest(layout, data, 3, 0, { level: 'all' })).toEqual({ kind: 'belt', id: upper.id, node: 3 });
  });
});

describe('views', () => {
  it('bounds every building, belt node and sorter end', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    kit.belt(1, 1001, line([-10, 4], [14, 4]));
    const bounds = layoutBounds(kit.layout(), data)!;
    expect(bounds.minX).toBeCloseTo(-10, 6);
    expect(bounds.maxX).toBeCloseTo(14, 6);
    expect(bounds.minY).toBeCloseTo(-2 / TILE, 6);
    expect(bounds.maxY).toBeCloseTo(4, 6);
  });

  it('has no bounds for an empty layout', () => {
    const layout = new LayoutKit().layout();
    expect(layoutBounds(layout, data)).toBeNull();
    expect(maxLevel(layout)).toBe(0);
  });

  it('fits the bounds into the canvas, centred, and maps back through screenToGrid', () => {
    const bounds = { minX: 0, maxX: 40, minY: 0, maxY: 20 };
    const view = fitView(bounds, 400, 300, 20);
    // Width is the tight side: 360 px for 40 tiles.
    expect(view.scale).toBeCloseTo(9, 6);
    const centre = screenToGrid(200, 150, view);
    expect(centre.x).toBeCloseTo(20, 6);
    expect(centre.y).toBeCloseTo(10, 6);
    // North is up: a smaller canvas y is a bigger grid y.
    expect(screenToGrid(200, 100, view).y).toBeGreaterThan(centre.y);
  });

  it('keeps the scale within a usable range', () => {
    const dot = fitView({ minX: 5, maxX: 5, minY: 5, maxY: 5 }, 400, 300);
    expect(dot.scale).toBeLessThanOrEqual(60);
    expect(dot.scale).toBeGreaterThanOrEqual(1);
    const vast = fitView({ minX: 0, maxX: 100000, minY: 0, maxY: 100000 }, 400, 300);
    expect(vast.scale).toBeGreaterThanOrEqual(0.05);
  });

  it('zooms about the cursor and keeps the point under it', () => {
    const view = fitView({ minX: 0, maxX: 40, minY: 0, maxY: 20 }, 400, 300, 20);
    const before = screenToGrid(120, 80, view);
    const zoomed = zoomAt(view, 120, 80, 2);
    expect(zoomed.scale).toBeCloseTo(view.scale * 2, 6);
    const after = screenToGrid(120, 80, zoomed);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomAt(view, 0, 0, 1e9).scale).toBe(60);
    expect(zoomAt(view, 0, 0, 1e-9).scale).toBe(0.05);
  });

  it('reports the highest level in use', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    kit.belt(1, 1001, [...line([0, 0], [3, 0], 0), ...line([3, 1], [6, 1], 2)]);
    expect(maxLevel(kit.layout())).toBe(2);
  });

  it('finds the centre of an entity', () => {
    const c = compositeLayout();
    const layout = c.kit.layout();
    expect(entityCentre(layout, data, { kind: 'building', id: c.asmB.id })).toEqual({ x: c.asmB.x, y: c.asmB.y });
    expect(entityCentre(layout, data, { kind: 'belt', id: c.belt.id, node: 3 })).toMatchObject({ x: 2, y: 6 });
    expect(entityCentre(layout, data, { kind: 'building', id: 9999 })).toBeNull();
  });
});

describe('describeEntity', () => {
  it('names a building, its recipe and where it stands', () => {
    const c = compositeLayout();
    const text = describeEntity(c.kit.layout(), data, { kind: 'building', id: c.asmA.id });
    expect(text).toContain('Assembling Machine Mk.I');
    expect(text).toContain(`#${c.asmA.id}`);
    expect(text).toContain(data.recipe(c.asmA.recipeId!).name);
  });

  it('names the item and tier of a belt, and the node', () => {
    const c = compositeLayout();
    const text = describeEntity(c.kit.layout(), data, { kind: 'belt', id: c.belt.id, node: 2 });
    expect(text).toContain('Conveyor Belt MK.I');
    expect(text).toContain('Iron Ore');
    expect(text).toContain('node 2');
  });

  it('names the sorter and the item it moves', () => {
    const c = compositeLayout();
    const layout = c.kit.layout();
    layout.sorters[0].filterItemId = 1001;
    const text = describeEntity(layout, data, { kind: 'sorter', id: layout.sorters[0].id });
    expect(text).toContain('Sorter MK.I');
    expect(text).toContain('Iron Ore');
  });

  it('says so for an entity that is not in the layout', () => {
    const layout = compositeLayout().kit.layout();
    expect(describeEntity(layout, data, { kind: 'sorter', id: 4242 })).toContain('4242');
  });
});

describe('spray coaters (Task 28)', () => {
  /** A belt flowing east along y = 10, a coater on its node 5 and the proliferator belt across it one level up. */
  function sprayed(): { layout: Layout; coaterId: number } {
    const kit = new LayoutKit();
    const belt = kit.belt(3, 1101, line([0, 10], [12, 10]));
    const coater = kit.coater(belt, 5);
    kit.belt(2, 1143, line([4, 7], [4, 13], 1));
    return { layout: kit.layout(), coaterId: coater.id };
  }

  it('draws the coater as a building: one rect', () => {
    const { layout } = sprayed();
    const { ctx, count } = fakeContext();
    renderLayout(ctx, layout, data, ALL);
    expect(count('rect')).toBe(1);
    // and only on the levels its body spans: ground and level 1 (it is 1.9 levels high), not level 2
    const levels = [0, 1, 2].map((level) => {
      const c = fakeContext();
      renderLayout(c.ctx, layout, data, { level, scale: 10 });
      return c.count('rect');
    });
    expect(levels).toEqual([1, 1, 0]);
  });

  it('a layout without coaters draws as before', () => {
    const kit = new LayoutKit();
    kit.belt(3, 1101, line([0, 10], [12, 10]));
    const { ctx, count } = fakeContext();
    renderLayout(ctx, kit.layout(), data, ALL);
    expect(count('rect')).toBe(0);
  });

  it('highlights a violation that names the coater', () => {
    const { layout, coaterId } = sprayed();
    const { ctx, calls } = fakeContext();
    const violation: Violation = { code: 'COATER_UNFED', entities: [{ kind: 'building', id: coaterId }], message: 'x' };
    renderLayout(ctx, layout, data, { ...ALL, highlight: [violation] });
    expect(calls.some((c) => c.name === 'rect' && c.strokeStyle === VIOLATION_COLOR)).toBe(true);
  });

  it('describes the coater and finds its centre', () => {
    const { layout, coaterId } = sprayed();
    expect(describeEntity(layout, data, { kind: 'building', id: coaterId })).toContain(`Spray Coater #${coaterId}`);
    expect(entityCentre(layout, data, { kind: 'building', id: coaterId })).toEqual({ x: 5, y: 10 });
  });

  it('the bounds and the hit test take it in; the belt under it is still hit first', () => {
    const { layout, coaterId } = sprayed();
    expect(layoutBounds(layout, data)).not.toBeNull();
    // on the axis the belt is hit; a little off it (0.27 tiles, past a belt's 0.25) the coater's body is
    expect(hitTest(layout, data, 5, 10)).toMatchObject({ kind: 'belt' });
    expect(hitTest(layout, data, 5, 10.27)).toEqual({ kind: 'building', id: coaterId });
  });
});

describe('previewKeyAction (final review, T25)', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
    previewKeyAction({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it('arrows pan, + and - zoom, 0 fits', () => {
    expect(key('ArrowLeft')).toEqual({ kind: 'pan', dx: PAN_STEP, dy: 0 });
    expect(key('ArrowRight')).toEqual({ kind: 'pan', dx: -PAN_STEP, dy: 0 });
    expect(key('ArrowUp')).toEqual({ kind: 'pan', dx: 0, dy: PAN_STEP });
    expect(key('ArrowDown')).toEqual({ kind: 'pan', dx: 0, dy: -PAN_STEP });
    expect(key('+')).toEqual({ kind: 'zoom', factor: ZOOM_STEP });
    expect(key('=')).toEqual({ kind: 'zoom', factor: ZOOM_STEP });
    expect(key('-')).toEqual({ kind: 'zoom', factor: 1 / ZOOM_STEP });
    expect(key('_')).toEqual({ kind: 'zoom', factor: 1 / ZOOM_STEP });
    expect(key('0')).toEqual({ kind: 'fit' });
  });

  it('leaves a key with Ctrl, Cmd or Alt held to the browser: Ctrl/Cmd +, - and 0 are the page zoom', () => {
    for (const k of ['+', '=', '-', '_', '0', 'ArrowLeft', 'ArrowUp']) {
      for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) expect(key(k, { [mod]: true }), `${k} with ${mod}`).toBeNull();
    }
  });

  it('does not count Shift, which many layouts need for +', () => {
    expect(key('+', { shiftKey: true })).toEqual({ kind: 'zoom', factor: ZOOM_STEP });
  });

  it('ignores other keys', () => {
    expect(key('a')).toBeNull();
    expect(key('Tab')).toBeNull();
  });
});
