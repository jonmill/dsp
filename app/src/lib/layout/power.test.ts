import { describe, expect, it } from 'vitest';
import { BELT_HALF_WIDTH_TILES, buildingDef, buildingOBBs, pointInOBBs, prefabToGrid, TILE } from '../geometry';
import type { Layout, PlacedBuilding } from '../geometry';
import { checkGeometry } from '../validate/geometry-checks';
import { ITEM, LayoutKit, line, onNode, onSlot } from '../validate/testkit';
import { placePowerNodes, powerTargets } from './power';
import { data, effects, occupancyOf } from './testkit';

const TESLA = 2201;
const WIRELESS = 2202;
const SATELLITE = 2212;

const meta = { geometrySource: 'approximate' as const, gameVersion: 'test', planTargetItemId: 1101, planTargetRate: 1 };

/** `count` Mk.I assemblers in a row, 6 tiles apart, starting at `x0`, ids from `firstId`. */
function row(count: number, x0 = 0, firstId = 1, y = 0): PlacedBuilding[] {
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    itemId: ITEM.assembler,
    x: x0 + 6 * i,
    y,
    z: 0,
    yaw: 0 as const,
    recipeId: 1,
  }));
}

const layoutOf = (buildings: PlacedBuilding[], over: Partial<Layout> = {}): Layout => ({
  buildings,
  belts: [],
  sorters: [],
  meta,
  ...over,
});

const codes = (layout: Layout, pattern: RegExp): string[] =>
  checkGeometry(layout, data, effects)
    .filter((v) => pattern.test(v.code))
    .map((v) => `${v.code}: ${v.message}`);

/** Effects with only these buildings unlocked of the pole types. */
const withPoles = (...ids: number[]) => ({
  ...effects,
  availableBuildings: new Set([...effects.availableBuildings].filter((i) => ![TESLA, WIRELESS, SATELLITE].includes(i)).concat(ids)),
});

describe('placePowerNodes', () => {
  it('covers and connects a row of six assemblers: no POWER_* violations, no overlap', () => {
    const machines = row(6);
    const nodes = placePowerNodes(machines, [], new Set(), occupancyOf(machines), data, effects);
    expect(nodes).not.toBeNull();
    expect(nodes!.length).toBeGreaterThanOrEqual(1);
    expect(nodes!.every((n) => n.itemId === TESLA)).toBe(true);
    const layout = layoutOf([...machines, ...nodes!]);
    expect(codes(layout, /^(POWER_|BUILDING_)/)).toEqual([]);
  });

  it('gives the nodes ids that no building has, and leaves the occupancy as it found it', () => {
    const machines = row(6);
    const occ = occupancyOf(machines);
    const nodes = placePowerNodes(machines, [], new Set(), occ, data, effects)!;
    const ids = new Set(machines.map((m) => m.id));
    for (const n of nodes) expect(ids.has(n.id)).toBe(false);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    // the same call again behaves the same: nothing of the first call stayed in the index
    const again = placePowerNodes(machines, [], new Set(), occ, data, effects)!;
    expect(again).toEqual(nodes);
  });

  it('covers a sorter midpoint that no machine centre explains: only a sorter is uncovered, so a node is added', () => {
    // A Tesla at (6, 16) reaches the assembler at (6, 8) (8 tiles = 10.05 m) but not the point 9.44 tiles away
    // (11.9 m, beyond its 10.5 m) where the sorter on the assembler's south slot sits.
    const kit = new LayoutKit(data, effects);
    const asm = kit.assembler(6, 8);
    const tesla = kit.building(ITEM.tesla, 6, 16);
    const belt = kit.belt(1, 1001, [
      [5, 6],
      [6, 6],
      [7, 6],
    ]);
    kit.sorter(onNode(belt, 1), onSlot(asm, 7));
    const base = kit.layout();
    expect(codes(base, /^POWER_UNCOVERED$/)).toHaveLength(1);

    const { consumerPoints, blockedPoints } = powerTargets(base, data);
    expect(consumerPoints).toHaveLength(1);
    const buildings = [asm, tesla];
    const without = placePowerNodes(buildings, [], blockedPoints, occupancyOf(buildings), data, effects);
    expect(without).toEqual([]);
    const nodes = placePowerNodes(buildings, consumerPoints, blockedPoints, occupancyOf(buildings), data, effects)!;
    expect(nodes.length).toBeGreaterThanOrEqual(1);

    const powered = { ...base, buildings: [...base.buildings, ...nodes] };
    expect(codes(powered, /^(POWER_|BUILDING_|BELT_IN_BUILDING)/)).toEqual([]);
  });

  it('keeps off the blocked points and still covers', () => {
    const machines = row(6);
    const first = placePowerNodes(machines, [], new Set(), occupancyOf(machines), data, effects)!;
    const blocked = new Set(first.map((n) => `${n.x},${n.y}`));
    const nodes = placePowerNodes(machines, [], blocked, occupancyOf(machines), data, effects)!;
    expect(nodes).not.toBeNull();
    for (const n of nodes) expect(blocked.has(`${n.x},${n.y}`)).toBe(false);
    expect(codes(layoutOf([...machines, ...nodes]), /^(POWER_|BUILDING_)/)).toEqual([]);
  });

  it('keeps the pole body off belts at every height, also for a pole wider than a tile', () => {
    // The Satellite Substation is 3.7 m wide: standing on a lattice point it sweeps over the cells beside it. Run a
    // belt one cell from where the first one goes when nothing is in the way, and see it move.
    const machines = row(3, 0, 1, 8);
    const types = withPoles(SATELLITE);
    const free = placePowerNodes(machines, [], new Set(), occupancyOf(machines), data, types)!;
    const kit = new LayoutKit(data, types);
    const beside = kit.belt(1, 1001, line([free[0].x + 1, free[0].y - 4], [free[0].x + 1, free[0].y + 4]));
    const base = layoutOf(machines, { belts: [beside] });
    const { blockedPoints } = powerTargets(base, data);
    const nodes = placePowerNodes(machines, [], blockedPoints, occupancyOf(machines), data, types)!;
    expect(nodes.every((n) => n.itemId === SATELLITE)).toBe(true);
    expect(nodes.some((n) => n.x === free[0].x && n.y === free[0].y)).toBe(false);

    // no belt node, at any height a belt can have, is inside a node's body grown by half a belt
    for (const n of nodes) {
      const obbs = buildingOBBs(n, buildingDef(data, n.itemId));
      for (const p of beside.nodes) {
        for (const z of [0, 1, 2]) expect(pointInOBBs(p.x, p.y, z, obbs, BELT_HALF_WIDTH_TILES), `(${p.x}, ${p.y}, ${z})`).toBe(false);
      }
    }
    expect(codes({ ...base, buildings: [...machines, ...nodes] }, /^(POWER_|BUILDING_)/)).toEqual([]);
  });

  it('links clusters that are far apart with relay nodes', () => {
    const machines = [...row(2, 0, 1), ...row(2, 120, 3)];
    const nodes = placePowerNodes(machines, [], new Set(), occupancyOf(machines), data, effects)!;
    expect(nodes).not.toBeNull();
    // 120 tiles = 150 m at 22.5 m per link: at least six links, so well over the two nodes the covers need
    expect(nodes.length).toBeGreaterThanOrEqual(7);
    const layout = layoutOf([...machines, ...nodes]);
    expect(codes(layout, /^(POWER_|BUILDING_)/)).toEqual([]);
  });

  it('prefers the Tesla Tower, and falls back to what is unlocked', () => {
    const machines = row(4);
    const all = placePowerNodes(machines, [], new Set(), occupancyOf(machines), data, withPoles(TESLA, WIRELESS, SATELLITE))!;
    expect(new Set(all.map((n) => n.itemId))).toEqual(new Set([TESLA]));
    const wireless = placePowerNodes(machines, [], new Set(), occupancyOf(machines), data, withPoles(WIRELESS))!;
    expect(new Set(wireless.map((n) => n.itemId))).toEqual(new Set([WIRELESS]));
    const satellite = placePowerNodes(machines, [], new Set(), occupancyOf(machines), data, withPoles(SATELLITE))!;
    expect(new Set(satellite.map((n) => n.itemId))).toEqual(new Set([SATELLITE]));
    for (const poles of [wireless, satellite]) {
      expect(codes(layoutOf([...machines, ...poles]), /^(POWER_|BUILDING_)/)).toEqual([]);
    }
  });

  it('returns null when no power node is unlocked', () => {
    const machines = row(2);
    expect(placePowerNodes(machines, [], new Set(), occupancyOf(machines), data, withPoles())).toBeNull();
  });

  it('returns null when nothing near a consumer is free for a node', () => {
    const machines = row(1);
    // every lattice point within 20 tiles is blocked
    const blocked = new Set<string>();
    for (let x = -20; x <= 20; x++) for (let y = -20; y <= 20; y++) blocked.add(`${x},${y}`);
    expect(placePowerNodes(machines, [], blocked, occupancyOf(machines), data, effects)).toBeNull();
  });

  it('needs no node for a layout without consumers', () => {
    expect(placePowerNodes([], [], new Set(), occupancyOf([]), data, effects)).toEqual([]);
  });

  it('counts a node already among the buildings', () => {
    const machines = row(2);
    const existing: PlacedBuilding = { id: 50, itemId: TESLA, x: 3, y: 4, z: 0, yaw: 0 };
    const buildings = [...machines, existing];
    expect(placePowerNodes(buildings, [], new Set(), occupancyOf(buildings), data, effects)).toEqual([]);
  });

  it('still links pre-existing nodes that cover everything but stand apart (no POWER_DISCONNECTED)', () => {
    // two clusters 120 tiles apart, each with its own Tesla Tower at it: every consumer is covered, nothing is linked
    const machines = [...row(2, 0, 1), ...row(2, 120, 3)];
    const existing: PlacedBuilding[] = [
      { id: 50, itemId: TESLA, x: 3, y: 4, z: 0, yaw: 0 },
      { id: 51, itemId: TESLA, x: 123, y: 4, z: 0, yaw: 0 },
    ];
    const buildings = [...machines, ...existing];
    expect(codes(layoutOf(buildings), /^POWER_/)).toEqual([expect.stringMatching(/^POWER_DISCONNECTED/)]);
    const relays = placePowerNodes(buildings, [], new Set(), occupancyOf(buildings), data, effects);
    expect(relays).not.toBeNull();
    expect(relays!.length).toBeGreaterThanOrEqual(5);
    expect(codes(layoutOf([...buildings, ...relays!]), /^(POWER_|BUILDING_)/)).toEqual([]);
  });

  it('returns null for pre-existing nodes that cover everything but stand apart when no node type is unlocked to link them', () => {
    const machines = [...row(1, 0, 1), ...row(1, 120, 2)];
    const existing: PlacedBuilding[] = [
      { id: 50, itemId: TESLA, x: 3, y: 4, z: 0, yaw: 0 },
      { id: 51, itemId: TESLA, x: 123, y: 4, z: 0, yaw: 0 },
    ];
    const buildings = [...machines, ...existing];
    expect(placePowerNodes(buildings, [], new Set(), occupancyOf(buildings), data, withPoles())).toBeNull();
  });

  it('covers the points in the validator sense: within the cover radius of the power point', () => {
    const machines = row(6);
    const points = [{ x: -9, y: 5 }, { x: 40, y: -7 }];
    const nodes = placePowerNodes(machines, points, new Set(), occupancyOf(machines), data, effects)!;
    const def = buildingDef(data, TESLA).power.node!;
    for (const p of points) {
      const near = nodes.some((n) => {
        const pp = prefabToGrid(n, def.powerPoint);
        return Math.hypot((pp.x - p.x) * TILE, (pp.y - p.y) * TILE) <= def.coverRadius;
      });
      expect(near, `point (${p.x}, ${p.y})`).toBe(true);
    }
  });

  it('is deterministic', () => {
    const machines = row(6);
    const a = placePowerNodes(machines, [{ x: 3, y: 9 }], new Set(), occupancyOf(machines), data, effects);
    const b = placePowerNodes(machines, [{ x: 3, y: 9 }], new Set(), occupancyOf(machines), data, effects);
    expect(a).toEqual(b);
  });
});
