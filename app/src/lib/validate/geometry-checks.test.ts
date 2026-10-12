import { describe, expect, test } from 'vitest';
import type { Building, Pose } from '../data';
import { buildingDef, LayoutIndex, slotInfos, sorterEnds, sorterEndsValid, TILE } from '../geometry';
import type { GridPoint, Layout } from '../geometry';
import { checkGeometry } from './geometry-checks';
import {
  compositeLayout,
  fixtureData,
  fixtureEffects,
  ITEM,
  LayoutKit,
  line,
  codesOf,
  onNode,
  onSlot,
  only,
  patchBuilding,
} from './testkit';
import type { P } from './testkit';
import type { Violation, ViolationCode } from './types';

/**
 * The shared sorter-ends predicate (`sorterEndsValid`, which the solver's tap assignment uses too) must give the
 * validator's own verdict on the distance part of rule 8 and on rule 10, for every sorter of every layout these tests
 * check. Sorters the validator does not judge (an end it cannot resolve or place) are left out.
 */
function expectSharedPredicateAgrees(kit: LayoutKit, layout: Layout, violations: Violation[]): void {
  const index = new LayoutIndex(layout);
  const reach = kit.data.data.constants.sorterMaxReachMeters;
  const about = (v: Violation, id: number): boolean => v.entities.some((e) => e.kind === 'sorter' && e.id === id);
  for (const s of layout.sorters) {
    if (violations.some((v) => (v.code === 'SORTER_SLOT_INVALID' || v.code === 'SORTER_TO_STATION') && about(v, s.id))) continue;
    let ends: ReturnType<typeof sorterEnds>;
    const facings: [number, number][] = [];
    let toBelt = false;
    try {
      ends = sorterEnds(s, layout, kit.data, index);
      for (const e of [s.pick, s.drop]) {
        if (e.kind === 'belt') toBelt = true;
        else {
          const b = index.building(e.buildingId, 'test');
          facings.push(slotInfos(b, buildingDef(kit.data, b.itemId))[e.slot].dir);
        }
      }
    } catch {
      continue; // ends that cannot be placed, or a slot that does not face along an axis: not judged by these rules
    }
    const rejected = violations.some(
      (v) => about(v, s.id) && (v.code === 'SORTER_SKEW' || (v.code === 'SORTER_SPAN' && / m apart,/.test(v.message))),
    );
    expect(sorterEndsValid({ ...ends, facings, toBelt }, reach), `sorter ${s.id}: ${violations.map((v) => v.message).join(' | ')}`).toBe(!rejected);
  }
}

const check = (kit: LayoutKit, layout: Layout = kit.layout()): Violation[] => {
  const violations = checkGeometry(layout, kit.data, kit.effects);
  expectSharedPredicateAgrees(kit, layout, violations);
  return violations;
};

/** A tesla tower close to the origin region, out of the way of the small layouts below. */
const powered = (kit: LayoutKit, x = -2, y = -3) => kit.tesla(x, y);

describe('testkit', () => {
  test('tapPoint gives the lattice point a span-N sorter on a slot taps, from the geometry kernel', () => {
    const kit = new LayoutKit();
    const asm = kit.assembler(0, 0);
    expect([1, 2, 3].map((span) => kit.tapPoint(asm, 3, span as 1 | 2 | 3))).toEqual([
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
    ]);
  });

  test('line steps one lattice point at a time and refuses a diagonal', () => {
    expect(line([0, 2], [3, 2], 1)).toEqual([
      { x: 0, y: 2, z: 1 },
      { x: 1, y: 2, z: 1 },
      { x: 2, y: 2, z: 1 },
      { x: 3, y: 2, z: 1 },
    ]);
    expect(line([3, 0], [3, -2]).map((p) => p.y)).toEqual([0, -1, -2]);
    expect(() => line([0, 0], [1, 1])).toThrow(/axis-aligned/);
  });

  test('layout() hands out copies of the arrays, so a test can edit the result', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    const layout = kit.layout();
    layout.buildings.pop();
    expect(kit.layout().buildings).toHaveLength(1);
  });
});

describe('the valid composite layout', () => {
  test('station + belt + 2 assemblers + sorters + tesla gives no violations', () => {
    const c = compositeLayout();
    expect(check(c.kit)).toEqual([]);
  });

  test('an empty layout is valid', () => {
    const kit = new LayoutKit();
    expect(check(kit)).toEqual([]);
  });

  test('a building whose item is not in GameData is a loud error, not a pass', () => {
    const kit = new LayoutKit();
    kit.building(9999, 0, 0);
    expect(() => check(kit)).toThrow(/item 9999/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('1 BUILDING_OVERLAP', () => {
  test('pass: assemblers with a gap, and assemblers touching face to face', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    kit.assembler(4, 0);
    kit.assembler(4 + 4 / TILE, 0); // touching the second one
    expect(only(check(kit), 'BUILDING_OVERLAP')).toEqual([]);
  });

  test('pass: the empty corner pocket of a cross-shaped station', () => {
    const kit = new LayoutKit();
    kit.station(0, 0);
    kit.assembler(3.5, 3.5);
    expect(only(check(kit), 'BUILDING_OVERLAP')).toEqual([]);
  });

  test('fail: two assemblers 2 tiles apart, naming both', () => {
    const kit = new LayoutKit();
    const a = kit.assembler(0, 0);
    const b = kit.assembler(2, 0);
    const v = only(check(kit), 'BUILDING_OVERLAP');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'building', id: a.id },
      { kind: 'building', id: b.id },
    ]);
    expect(v[0].message).toContain(`building ${a.id}`);
    expect(v[0].message).toContain(`building ${b.id}`);
    expect(v[0].mirrors).toBe('BuildTool_Click.CheckBuildConditions');
  });

  test('fail: an assembler on the arm of a station (either collider counts), reported once', () => {
    const kit = new LayoutKit();
    kit.station(0, 0);
    kit.assembler(3, 3); // overlaps both arms of the cross
    expect(only(check(kit), 'BUILDING_OVERLAP')).toHaveLength(1);
  });

  test('buildings at different heights only overlap when their height ranges do', () => {
    const above = new LayoutKit();
    above.assembler(0, 0);
    above.building(ITEM.assembler, 0, 0, 0, { z: 4 }); // base at 4 levels, the lower one ends at 3.45
    expect(only(check(above), 'BUILDING_OVERLAP')).toEqual([]);

    const inside = new LayoutKit();
    inside.assembler(0, 0);
    inside.building(ITEM.assembler, 0, 0, 0, { z: 3 }); // an assembler is not multiLevel: no stacking exemption
    expect(only(check(inside), 'BUILDING_OVERLAP')).toHaveLength(1);
  });

  describe('multiLevel stacking at the lapJoint offset is exempt', () => {
    // Make the fixture labs 10 m tall so that a stack at the 4 m lapJoint really overlaps without the exemption.
    const tall = patchBuilding(fixtureData, ITEM.matrixLab, (b) => ({
      ...b,
      geometry: {
        ...b.geometry,
        colliders: b.geometry.colliders.map((c) => ({ ...c, center: [0, 5, 0], halfExtents: [c.halfExtents[0], 5, c.halfExtents[2]] })),
      },
    }));
    const lapLevels = 3; // the lab's lapJoint, 4 m

    test('pass: labs at 0, 3 and 6 levels (every pair, including the ends of the stack)', () => {
      const kit = new LayoutKit(tall, fixtureEffects);
      for (const z of [0, lapLevels, 2 * lapLevels]) kit.building(ITEM.matrixLab, 0, 0, 0, { z });
      expect(only(check(kit), 'BUILDING_OVERLAP')).toEqual([]);
    });

    test('fail: the same labs at 0 and 2 levels (not the lapJoint offset)', () => {
      const kit = new LayoutKit(tall, fixtureEffects);
      kit.building(ITEM.matrixLab, 0, 0, 0, { z: 0 });
      kit.building(ITEM.matrixLab, 0, 0, 0, { z: 2 });
      expect(only(check(kit), 'BUILDING_OVERLAP')).toHaveLength(1);
    });

    test('fail: at the lapJoint offset but not on top of each other', () => {
      const kit = new LayoutKit(tall, fixtureEffects);
      kit.building(ITEM.matrixLab, 0, 0, 0, { z: 0 });
      kit.building(ITEM.matrixLab, 1, 0, 0, { z: lapLevels });
      expect(only(check(kit), 'BUILDING_OVERLAP')).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('2 BELT_IN_BUILDING', () => {
  test('pass: a belt one lattice column beside an assembler', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    kit.belt(1, 1001, line([2, -2], [2, 2]));
    expect(only(check(kit), 'BELT_IN_BUILDING')).toEqual([]);
  });

  test('pass: a belt above the building (assembler top is 3.45 levels, belt at 4)', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    kit.belt(1, 1001, [[0, 0, 4]]);
    expect(only(check(kit), 'BELT_IN_BUILDING')).toEqual([]);
  });

  test('fail: a node inside the footprint names the belt node and the building', () => {
    const kit = new LayoutKit();
    const a = kit.assembler(0, 0);
    const belt = kit.belt(1, 1001, line([-3, 0], [3, 0]));
    const v = only(check(kit), 'BELT_IN_BUILDING');
    // The assembler is 3.18 tiles wide: lattice points -1, 0, 1 are inside.
    expect(v.map((x) => x.entities[0])).toEqual([
      { kind: 'belt', id: belt.id, node: 2 },
      { kind: 'belt', id: belt.id, node: 3 },
      { kind: 'belt', id: belt.id, node: 4 },
    ]);
    expect(v[0].entities[1]).toEqual({ kind: 'building', id: a.id });
    expect(v[0].message).toContain(`belt ${belt.id}`);
    expect(v[0].message).toContain(`building ${a.id}`);
    expect(v[0].mirrors).toBe('BuildTool_Path.CheckBuildConditions');
  });

  test('the belt is inflated by its half width: 0.2 tile off the face is inside, 0.3 is not', () => {
    const face = 2 / TILE; // 1.5915 tiles
    const near = new LayoutKit();
    near.assembler(0, 0);
    near.belt(1, 1001, [[face + 0.2, 0]]);
    expect(only(check(near), 'BELT_IN_BUILDING')).toHaveLength(1);

    const far = new LayoutKit();
    far.assembler(0, 0);
    far.belt(1, 1001, [[face + 0.3, 0]]);
    expect(only(check(far), 'BELT_IN_BUILDING')).toEqual([]);
  });

  test('fail: a ground belt under the building, with the node z inside its height range', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    kit.belt(1, 1001, [[0, 0, 3]]);
    expect(only(check(kit), 'BELT_IN_BUILDING')).toHaveLength(1);
  });

  test('fail: a belt through the arm of a station, pass: through its empty corner pocket', () => {
    const arm = new LayoutKit();
    arm.station(0, 0);
    arm.belt(1, 1001, [[3, 0]]);
    expect(only(check(arm), 'BELT_IN_BUILDING')).toHaveLength(1);

    const pocket = new LayoutKit();
    pocket.station(0, 0);
    pocket.belt(1, 1001, [[3, 3]]);
    expect(only(check(pocket), 'BELT_IN_BUILDING')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

/** A belt along x at y = 6 crossed by one along y at x = 20 that rides at z = 1 over it. */
function crossing(kit: LayoutKit) {
  const flat = kit.belt(1, 1001, line([14, 6], [26, 6]));
  const over = kit.belt(2, 1002, [
    ...line([20, 0], [20, 2]), // flat
    ...line([20, 2], [20, 9], 1), // lift at (20, 2), then flat at z = 1 across y = 6
    ...line([20, 9], [20, 11]), // lift down at (20, 9), then flat
  ]);
  return { flat, over };
}

describe('3 BELT_OVERLAP', () => {
  test('pass: one belt rides over another on a ramp, and the whole layout is clean', () => {
    const kit = new LayoutKit();
    crossing(kit);
    expect(check(kit)).toEqual([]);
  });

  test('fail: two belts share a node, naming both belt nodes', () => {
    const kit = new LayoutKit();
    const a = kit.belt(1, 1001, line([0, 3], [6, 3]));
    const b = kit.belt(1, 1002, line([3, 0], [3, 6]));
    const v = only(check(kit), 'BELT_OVERLAP');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'belt', id: a.id, node: 3 },
      { kind: 'belt', id: b.id, node: 3 },
    ]);
    expect(v[0].message).toContain(`belt ${a.id}`);
    expect(v[0].message).toContain(`belt ${b.id}`);
    expect(v[0].mirrors).toBe('BuildTool_Path.CheckBuildConditions');
  });

  test('fail: a belt that crosses itself (non-consecutive nodes at one point)', () => {
    const kit = new LayoutKit();
    const loop = kit.belt(1, 1001, [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
    const v = only(check(kit), 'BELT_OVERLAP');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'belt', id: loop.id, node: 0 },
      { kind: 'belt', id: loop.id, node: 4 },
    ]);
  });

  test('consecutive nodes at one point are a broken step (BELT_DISCONNECTED), not an overlap', () => {
    const kit = new LayoutKit();
    kit.belt(1, 1001, [[0, 0], [0, 0], [1, 0]]);
    expect(only(check(kit), 'BELT_OVERLAP')).toEqual([]);
    expect(only(check(kit), 'BELT_DISCONNECTED')).toHaveLength(1);
  });

  test('a belt that merges into another may end on the target node', () => {
    const kit = new LayoutKit();
    const target = kit.belt(1, 1001, line([0, 3], [6, 3]));
    kit.belt(1, 1001, line([3, 0], [3, 3]), { sink: { kind: 'belt', beltId: target.id, node: 3 } });
    expect(only(check(kit), 'BELT_OVERLAP')).toEqual([]);
  });

  test('two belts merging into one target node from opposite sides is accepted', () => {
    const kit = new LayoutKit();
    const target = kit.belt(1, 1001, line([0, 3], [6, 3]));
    const sink = { kind: 'belt', beltId: target.id, node: 3 } as const;
    kit.belt(1, 1001, line([3, 0], [3, 2]), { sink });
    kit.belt(1, 1001, line([3, 6], [3, 4]), { sink });
    expect(check(kit)).toEqual([]);
  });

  test('two belts that both END ON the target node overlap each other: unsupported in v1', () => {
    // Each is exempt against the target node, but not against the other merging belt, so BELT_OVERLAP reports them.
    // The router merges from the side (last node beside the target node), where two belts do not collide.
    const kit = new LayoutKit();
    const target = kit.belt(1, 1001, line([0, 3], [6, 3]));
    const sink = { kind: 'belt', beltId: target.id, node: 3 } as const;
    const a = kit.belt(1, 1001, line([3, 0], [3, 3]), { sink });
    const b = kit.belt(1, 1001, line([3, 6], [3, 3]), { sink });
    const v = only(check(kit), 'BELT_OVERLAP');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'belt', id: a.id, node: 3 },
      { kind: 'belt', id: b.id, node: 3 },
    ]);
  });

  test('the merge exemption is only for that belt\'s last node on the declared target node', () => {
    const noSink = new LayoutKit();
    noSink.belt(1, 1001, line([0, 3], [6, 3]));
    noSink.belt(1, 1001, line([3, 0], [3, 3]));
    expect(only(check(noSink), 'BELT_OVERLAP')).toHaveLength(1);

    const wrongNode = new LayoutKit();
    const target = wrongNode.belt(1, 1001, line([0, 3], [6, 3]));
    wrongNode.belt(1, 1001, line([3, 0], [3, 3]), { sink: { kind: 'belt', beltId: target.id, node: 2 } });
    expect(only(check(wrongNode), 'BELT_OVERLAP')).toHaveLength(1);

    const notLast = new LayoutKit();
    const t2 = notLast.belt(1, 1001, line([0, 3], [6, 3]));
    notLast.belt(1, 1001, line([3, 0], [3, 5]), { sink: { kind: 'belt', beltId: t2.id, node: 3 } });
    expect(only(check(notLast), 'BELT_OVERLAP')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('4 BELT_DISCONNECTED', () => {
  test('pass: flat steps and vertical lifts', () => {
    const kit = new LayoutKit();
    kit.belt(1, 1001, [[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1], [3, 0, 1], [4, 0, 1]]);
    expect(only(check(kit), 'BELT_DISCONNECTED')).toEqual([]);
  });

  test.each([
    ['a diagonal step', [[0, 0, 0], [1, 1, 0]]],
    ['a jump of two tiles', [[0, 0, 0], [2, 0, 0]]],
    ['a horizontal step that also changes height (a diagonal ramp)', [[0, 0, 0], [1, 0, 1]]],
    ['a lift of two levels in one step', [[0, 0, 0], [0, 0, 2]]],
    ['two nodes at one point', [[0, 0, 0], [0, 0, 0]]],
    ['a half-tile step', [[0, 0, 0], [0.5, 0, 0]]],
  ] as const)('fail: %s, naming the belt and the first node of the step', (_name, pts) => {
    const kit = new LayoutKit();
    const belt = kit.belt(1, 1001, pts.map(([x, y, z]) => [x + 5, y + 5, z] as const));
    const v = only(check(kit), 'BELT_DISCONNECTED');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([{ kind: 'belt', id: belt.id, node: 0 }]);
    expect(v[0].message).toContain(`belt ${belt.id}`);
    expect(v[0].mirrors).toBe('BuildTool_Path.CheckBuildConditions');
  });

  test('fail: a belt with no nodes', () => {
    const kit = new LayoutKit();
    const belt = kit.belt(1, 1001, []);
    const v = only(check(kit), 'BELT_DISCONNECTED');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain(`belt ${belt.id}`);
  });
});

// ---------------------------------------------------------------------------------------------

describe('5 BELT_BAD_RAMP', () => {
  const bad = (pts: readonly (readonly [number, number, number])[]) => {
    const kit = new LayoutKit();
    const belt = kit.belt(1, 1001, pts);
    return { v: only(check(kit), 'BELT_BAD_RAMP'), belt };
  };

  test('pass: two flat steps, a lift, two flat steps', () => {
    expect(bad([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1], [3, 0, 1], [4, 0, 1]]).v).toEqual([]);
  });

  test('pass: a run of several lifts is one ramp', () => {
    expect(bad([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1], [2, 0, 2], [2, 0, 3], [3, 0, 3], [4, 0, 3]]).v).toEqual([]);
  });

  test('pass: a descending ramp', () => {
    expect(bad([[0, 0, 2], [1, 0, 2], [2, 0, 2], [2, 0, 1], [2, 0, 0], [3, 0, 0], [4, 0, 0]]).v).toEqual([]);
  });

  test('pass: a turn exactly two steps after the lift, and two steps before it', () => {
    expect(
      bad([[0, 3, 0], [0, 2, 0], [0, 1, 0], [0, 0, 0], [0, 0, 1], [0, -1, 1], [0, -2, 1], [1, -2, 1]]).v,
    ).toEqual([]);
  });

  test('pass: two ramps separated by exactly two flat steps', () => {
    expect(
      bad([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1], [3, 0, 1], [4, 0, 1], [4, 0, 2], [5, 0, 2], [6, 0, 2]]).v,
    ).toEqual([]);
  });

  test('fail: only one flat step before the lift, naming the belt and the lift node', () => {
    const { v, belt } = bad([[1, 0, 0], [2, 0, 0], [2, 0, 1], [3, 0, 1], [4, 0, 1]]);
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([{ kind: 'belt', id: belt.id, node: 1 }]);
    expect(v[0].message).toContain(`belt ${belt.id}`);
    expect(v[0].message).toMatch(/before/);
    expect(v[0].mirrors).toBe('BuildTool_Path.CheckBuildConditions');
  });

  test('fail: the belt starts with a lift', () => {
    expect(bad([[0, 0, 0], [0, 0, 1], [1, 0, 1], [2, 0, 1]]).v).toHaveLength(1);
  });

  test('fail: only one flat step after the lift', () => {
    const { v } = bad([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1], [3, 0, 1]]);
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/after/);
  });

  test('fail: the belt ends on the lift', () => {
    expect(bad([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1]]).v).toHaveLength(1);
  });

  test('fail: a turn within two steps after the lift', () => {
    expect(bad([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1], [3, 0, 1], [3, 1, 1], [3, 2, 1]]).v).toHaveLength(1);
  });

  test('fail: a turn within two steps before the lift', () => {
    expect(bad([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 2, 1], [1, 3, 1]]).v).toHaveLength(1);
  });

  test('fail: a turn at the lift itself (east before, north after)', () => {
    expect(bad([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1], [2, 1, 1], [2, 2, 1]]).v).toHaveLength(1);
  });

  test('fail: up and straight back down with no flat steps between', () => {
    expect(bad([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1], [2, 0, 0], [3, 0, 0], [4, 0, 0]]).v.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('6 BELT_TOO_HIGH', () => {
  /** A straight belt that climbs to `top` levels on a single lift run. */
  const climb = (top: number): [number, number, number][] => [
    [0, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
    ...Array.from({ length: top }, (_, i): [number, number, number] => [2, 0, i + 1]),
    [3, 0, top],
    [4, 0, top],
  ];

  test('pass: up to the base limit of 12 levels', () => {
    const kit = new LayoutKit();
    kit.belt(1, 1001, climb(12));
    expect(check(kit)).toEqual([]);
  });

  test('fail: 13 levels, naming the belt and the first node over the limit', () => {
    const kit = new LayoutKit();
    const belt = kit.belt(1, 1001, climb(13));
    const v = only(check(kit), 'BELT_TOO_HIGH');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([{ kind: 'belt', id: belt.id, node: 15 }]);
    expect(v[0].message).toContain(`belt ${belt.id}`);
    expect(v[0].message).toContain('13');
    expect(v[0].mirrors).toBe('BuildTool_Path.CheckBuildConditions');
  });

  test('the limit comes from the tech effects: 13 levels pass with beltMaxLevel 18', () => {
    const kit = new LayoutKit(fixtureData, { ...fixtureEffects, beltMaxLevel: 18 });
    kit.belt(1, 1001, climb(13));
    expect(only(check(kit), 'BELT_TOO_HIGH')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('7 BELT_PORT_MISMATCH', () => {
  /** Station A's port 1 (north, middle) feeds station B's port 1: first node (0,4), last node (12,4). */
  function stationToStation(kit: LayoutKit) {
    const a = kit.station(0, 0);
    const b = kit.station(12, 0);
    kit.tesla(6, 0);
    const belt = kit.belt(1, 1001, [...line([0, 4], [0, 5]), ...line([1, 5], [12, 5]), { x: 12, y: 4, z: 0 }], {
      source: { buildingId: a.id, port: 1 },
      sink: { kind: 'port', buildingId: b.id, port: 1 },
    });
    return { a, b, belt };
  }

  test('pass: a source at the first lattice point outside the port, a sink at the last', () => {
    const kit = new LayoutKit();
    stationToStation(kit);
    expect(check(kit)).toEqual([]);
  });

  test('fail: the first node is not the port\'s first outside point', () => {
    const kit = new LayoutKit();
    const { a, belt } = stationToStation(kit);
    belt.nodes[0] = { x: 1, y: 4, z: 0 };
    const v = only(check(kit), 'BELT_PORT_MISMATCH');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'belt', id: belt.id, node: 0 },
      { kind: 'building', id: a.id },
    ]);
    expect(v[0].message).toContain(`belt ${belt.id}`);
    expect(v[0].message).toContain(`building ${a.id}`);
    expect(v[0].mirrors).toBe('BuildTool_Path.CheckBuildConditions');
  });

  test('fail: the last node of a belt into a port is not the port\'s first outside point', () => {
    const kit = new LayoutKit();
    const { b, belt } = stationToStation(kit);
    belt.nodes[belt.nodes.length - 1] = { x: 13, y: 4, z: 0 };
    const v = only(check(kit), 'BELT_PORT_MISMATCH');
    expect(v).toHaveLength(1);
    expect(v[0].entities[0]).toEqual({ kind: 'belt', id: belt.id, node: belt.nodes.length - 1 });
    expect(v[0].entities[1]).toEqual({ kind: 'building', id: b.id });
  });

  test('fail: the first node is at the right place but not on the ground (z 0)', () => {
    const kit = new LayoutKit();
    const { belt } = stationToStation(kit);
    belt.nodes[0] = { x: 0, y: 4, z: 1 };
    expect(only(check(kit), 'BELT_PORT_MISMATCH')).toHaveLength(1);
  });

  test('fail: the source building does not exist', () => {
    const kit = new LayoutKit();
    const { belt } = stationToStation(kit);
    belt.source = { buildingId: 99, port: 1 };
    const v = only(check(kit), 'BELT_PORT_MISMATCH');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('building 99');
  });

  test('fail: the port index does not exist, or the building has no ports', () => {
    const kit = new LayoutKit();
    const { belt } = stationToStation(kit);
    belt.source = { buildingId: belt.source!.buildingId, port: 12 };
    const v = only(check(kit), 'BELT_PORT_MISMATCH');
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/port 12/);

    const noPorts = new LayoutKit();
    const asm = noPorts.assembler(0, 0);
    noPorts.belt(1, 1001, [[2, 0]], { source: { buildingId: asm.id, port: 0 } });
    expect(only(check(noPorts), 'BELT_PORT_MISMATCH')).toHaveLength(1);
  });

  test('fail: a belt sink that names a belt or node that does not exist', () => {
    const missingBelt = new LayoutKit();
    missingBelt.belt(1, 1001, line([0, 0], [3, 0]), { sink: { kind: 'belt', beltId: 42, node: 0 } });
    const v = only(check(missingBelt), 'BELT_PORT_MISMATCH');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('belt 42');

    const missingNode = new LayoutKit();
    const target = missingNode.belt(1, 1001, line([0, 3], [6, 3]));
    missingNode.belt(1, 1001, line([3, 0], [3, 2]), { sink: { kind: 'belt', beltId: target.id, node: 99 } });
    expect(only(check(missingNode), 'BELT_PORT_MISMATCH')).toHaveLength(1);
  });

  describe('a belt merging into another belt (sink: belt)', () => {
    /** A target belt along y = 3, and a belt through `nodes` that merges into the target's node 3, the point (3, 3). */
    function merge(nodes: readonly (P | GridPoint)[]) {
      const kit = new LayoutKit();
      const target = kit.belt(1, 1001, line([0, 3], [6, 3]));
      const merging = kit.belt(1, 1001, nodes, { sink: { kind: 'belt', beltId: target.id, node: 3 } });
      return { kit, target, merging };
    }

    test('pass: the last node is beside the target node (a side merge), from either side', () => {
      for (const nodes of [line([3, 0], [3, 2]), line([3, 6], [3, 4])]) {
        expect(check(merge(nodes).kit), `from (3, ${nodes[0].y})`).toEqual([]);
      }
    });

    test('pass: the last node is the target node itself', () => {
      const { kit } = merge(line([3, 0], [3, 3]));
      expect(only(check(kit), 'BELT_PORT_MISMATCH')).toEqual([]);
      expect(only(check(kit), 'BELT_OVERLAP')).toEqual([]);
    });

    test.each([
      ['two tiles away', line([3, -2], [3, 1])],
      ['diagonal to it', line([2, 0], [2, 2])],
      ['beside it but one level higher', line([3, 0], [3, 2], 1)],
    ])('fail: the last node is %s, naming both belts', (_name, nodes) => {
      const { kit, target, merging } = merge(nodes);
      const v = only(check(kit), 'BELT_PORT_MISMATCH');
      expect(v).toHaveLength(1);
      expect(v[0].entities).toEqual([
        { kind: 'belt', id: merging.id, node: merging.nodes.length - 1 },
        { kind: 'belt', id: target.id, node: 3 },
      ]);
      expect(v[0].message).toContain(`belt ${merging.id}`);
      expect(v[0].message).toContain(`belt ${target.id}`);
      expect(v[0].message).toMatch(/beside|one tile/);
      expect(v[0].mirrors).toBe('BuildTool_Path.CheckBuildConditions');
    });

    test('fail: the target node is the first node of the target belt', () => {
      const kit = new LayoutKit();
      const target = kit.belt(1, 1001, line([3, 3], [8, 3]));
      const merging = kit.belt(1, 1001, line([3, 0], [3, 2]), { sink: { kind: 'belt', beltId: target.id, node: 0 } });
      const v = only(check(kit), 'BELT_PORT_MISMATCH');
      expect(v).toHaveLength(1);
      expect(v[0].message).toContain(`belt ${merging.id}`);
      expect(v[0].message).toMatch(/first node/);
    });
  });

  test('a port that does not face along an axis is reported, not thrown', () => {
    const skew: Pose = { position: [0, 0, 2.7], rotation: [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)] };
    const data = patchBuilding(fixtureData, ITEM.ils, (b: Building) => ({
      ...b,
      geometry: { ...b.geometry, ports: [skew] },
    }));
    const kit = new LayoutKit(data, fixtureEffects);
    const station = kit.station(0, 0);
    kit.belt(1, 1001, [[0, 4]], { source: { buildingId: station.id, port: 0 } });
    const v = only(check(kit), 'BELT_PORT_MISMATCH');
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/port 0.*axis/);
  });
});

// ---------------------------------------------------------------------------------------------

/** An assembler at the origin with a quiet tesla, for sorter tests on its slot 3 (east face, y = 0.796). */
function lone() {
  const kit = new LayoutKit();
  const asm = kit.assembler(0, 0);
  powered(kit);
  return { kit, asm };
}

describe('8 SORTER_SPAN', () => {
  test.each([
    [1, 2],
    [2, 3],
    [3, 4],
  ] as const)('pass: a span-%i sorter taps the belt at x = %i (slot 3, row y = 1)', (span, x) => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([x, -1], [x, 3]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3), span);
    expect(check(kit)).toEqual([]);
  });

  test('pass: an output sorter (building to belt) at the same tap', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([3, -1], [3, 3]));
    kit.sorter(onSlot(asm, 3), onNode(belt, 2), 2);
    expect(check(kit)).toEqual([]);
  });

  test('fail: a span-2 sorter on a belt at the span-1 tap, naming sorter, slot and the expected tap', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3]));
    const s = kit.sorter(onNode(belt, 2), onSlot(asm, 3), 2);
    const v = only(check(kit), 'SORTER_SPAN');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toContainEqual({ kind: 'sorter', id: s.id });
    expect(v[0].message).toContain(`sorter ${s.id}`);
    expect(v[0].message).toContain('(3, 1)');
    expect(v[0].mirrors).toBe('BuildTool_Inserter.CheckBuildConditions');
  });

  test('fail: the tap is in the right column but on the wrong row', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3]));
    kit.sorter(onNode(belt, 1), onSlot(asm, 3), 1); // node 1 is (2, 0); the tap for slot 3 is (2, 1)
    expect(only(check(kit), 'SORTER_SPAN')).toHaveLength(1);
  });

  test('fail: a span that is not 1, 2 or 3', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3), 4 as 1);
    expect(only(check(kit), 'SORTER_SPAN')).toHaveLength(1);
  });

  test('fail: a belt endpoint that does not exist', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3]));
    kit.sorter({ kind: 'belt', beltId: 77, node: 0 }, onSlot(asm, 3));
    kit.sorter({ kind: 'belt', beltId: belt.id, node: 40 }, onSlot(asm, 4));
    const v = only(check(kit), 'SORTER_SPAN');
    expect(v).toHaveLength(2);
    expect(v[0].message).toContain('belt 77');
    expect(v[1].message).toContain('node 40');
  });

  test('fail: farther than 5.5 m in 3D (belt end 4 levels up)', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3], 4));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3), 1);
    const v = only(check(kit), 'SORTER_SPAN');
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/5\.5 m/);
  });

  test('pass: the same sorter one level up is within reach', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3], 1));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3), 1);
    expect(only(check(kit), 'SORTER_SPAN')).toEqual([]);
  });

  describe('building to building', () => {
    test('pass: spans 1 and 2 at the matching gaps (the composite link is span 1)', () => {
      const c = compositeLayout();
      expect(c.link.span).toBe(1);
      expect(only(check(c.kit), 'SORTER_SPAN')).toEqual([]);

      const kit = new LayoutKit();
      const a = kit.assembler(0, 0);
      const b = kit.assembler(5, 0);
      powered(kit, 2, -4);
      kit.sorter(onSlot(a, 4), onSlot(b, 10), 2);
      expect(check(kit)).toEqual([]);
    });

    test('fail: the declared span does not match the gap between the first-outside points', () => {
      for (const span of [1, 3] as const) {
        const kit = new LayoutKit();
        const a = kit.assembler(0, 0);
        const b = kit.assembler(5, 0); // the gap is a span-2 gap
        kit.sorter(onSlot(a, 4), onSlot(b, 10), span);
        const v = only(check(kit), 'SORTER_SPAN');
        expect(v, `span ${span}`).toHaveLength(1);
        expect(v[0].message).toMatch(/span/);
      }
    });

    test('fail: the slots do not face each other (east face to a north face)', () => {
      const kit = new LayoutKit();
      const a = kit.assembler(0, 0);
      const b = kit.assembler(4, 0);
      kit.sorter(onSlot(a, 4), onSlot(b, 1), 1);
      const v = only(check(kit), 'SORTER_SPAN');
      expect(v).toHaveLength(1);
      expect(v[0].message).toMatch(/face each other/);
    });

    test('fail: the ends are closer than 1 m (smelters touching, slots 0.78 m apart)', () => {
      const kit = new LayoutKit();
      const half = 1.5 / TILE;
      const a = kit.smelter(2 - half, 0);
      const b = kit.smelter(2 + half, 0);
      kit.sorter(onSlot(a, 4), onSlot(b, 10), 1);
      const v = only(check(kit), 'SORTER_SPAN');
      expect(v).toHaveLength(1);
      expect(v[0].message).toMatch(/1 m/);
    });
  });

  test('a sorter between two belts is only held to the reach limits', () => {
    const kit = new LayoutKit();
    const a = kit.belt(1, 1001, line([0, 0], [0, 3]));
    const b = kit.belt(1, 1001, line([2, 0], [2, 3]));
    kit.sorter(onNode(a, 1), onNode(b, 1), 2);
    expect(only(check(kit), 'SORTER_SPAN')).toEqual([]);
    const far = kit.belt(1, 1001, line([20, 0], [20, 3]));
    kit.sorter(onNode(a, 1), onNode(far, 1), 3);
    expect(only(check(kit), 'SORTER_SPAN')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('9 SORTER_SLOT_INVALID and SORTER_SLOT_REUSED', () => {
  test('pass: distinct slots in range', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3));
    kit.sorter(onSlot(asm, 5), onNode(belt, 0));
    const v = check(kit);
    expect(only(v, 'SORTER_SLOT_INVALID')).toEqual([]);
    expect(only(v, 'SORTER_SLOT_REUSED')).toEqual([]);
  });

  test.each([12, -1, 1.5])('fail: slot %s does not exist on an assembler with 12 slots', (slot) => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3]));
    const s = kit.sorter(onNode(belt, 2), onSlot(asm, slot));
    const v = only(check(kit), 'SORTER_SLOT_INVALID');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'sorter', id: s.id },
      { kind: 'building', id: asm.id },
    ]);
    expect(v[0].message).toContain(`sorter ${s.id}`);
    expect(v[0].message).toContain(`building ${asm.id}`);
    expect(v[0].mirrors).toBe('BuildTool_Inserter.CheckBuildConditions');
  });

  test('fail: a sorter on a building that is not in the layout', () => {
    const { kit } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3]));
    kit.sorter(onNode(belt, 2), { kind: 'building', buildingId: 55, slot: 0 });
    const v = only(check(kit), 'SORTER_SLOT_INVALID');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('building 55');
  });

  test('fail: two sorters on one building slot, naming both sorters and the building', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3]));
    const belt2 = kit.belt(1, 1002, line([3, -1], [3, 3]));
    const s1 = kit.sorter(onNode(belt, 2), onSlot(asm, 3), 1);
    const s2 = kit.sorter(onNode(belt2, 2), onSlot(asm, 3), 2);
    const v = only(check(kit), 'SORTER_SLOT_REUSED');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'sorter', id: s1.id },
      { kind: 'sorter', id: s2.id },
      { kind: 'building', id: asm.id },
    ]);
    expect(v[0].message).toContain('slot 3');
    expect(v[0].mirrors).toBe('BuildTool_Inserter.CheckBuildConditions');
  });

  describe('a slot that does not face along an axis (future real data)', () => {
    const skew: Pose = { position: [1.11, 0, 0], rotation: [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)] };
    const data = patchBuilding(fixtureData, ITEM.assembler, (b: Building) => {
      const slots = b.geometry.slots.map((s, i) => (i === 3 ? skew : s));
      return { ...b, geometry: { ...b.geometry, slots } };
    });

    test('does not crash: sorters on that slot get SORTER_SLOT_INVALID naming the cause, the rest is still checked', () => {
      const kit = new LayoutKit(data, fixtureEffects);
      const asm = kit.assembler(0, 0);
      powered(kit);
      const east = kit.belt(1, 1001, line([2, -1], [2, 3]));
      const west = kit.belt(1, 1002, line([-2, -1], [-2, 3]));
      const onSkew = kit.sorter(onNode(east, 2), onSlot(asm, 3)); // slot 3 is the skew one
      kit.sorter(onNode(east, 1), onSlot(asm, 4)); // east face, middle: tap (2, 0)
      kit.sorter(onNode(west, 2), onSlot(asm, 11)); // west face, north end: tap (-2, 1)
      const v = check(kit);
      expect(codesOf(v)).toEqual(['SORTER_SLOT_INVALID']);
      expect(v[0].entities).toContainEqual({ kind: 'sorter', id: onSkew.id });
      expect(v[0].message).toMatch(/slot 3/);
      expect(v[0].message).toMatch(/axis/);
    });

    test('a wrong tap on a good slot of the same building is still reported', () => {
      const kit = new LayoutKit(data, fixtureEffects);
      const asm = kit.assembler(0, 0);
      const east = kit.belt(1, 1001, line([2, -1], [2, 3]));
      kit.sorter(onNode(east, 3), onSlot(asm, 4)); // slot 4 taps (2, 0), not (2, 2)
      expect(only(check(kit), 'SORTER_SPAN')).toHaveLength(1);
    });

    test('the other checks still run for the building (an overlap next to it is reported)', () => {
      const kit = new LayoutKit(data, fixtureEffects);
      kit.assembler(0, 0);
      kit.assembler(1, 0);
      expect(only(check(kit), 'BUILDING_OVERLAP')).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('10 SORTER_SKEW', () => {
  /** Assembler A at the origin, B east of it at lateral offset `dy`; one sorter between slots 4 and 10. */
  function pair(dy: number) {
    const kit = new LayoutKit();
    const a = kit.assembler(0, 0);
    const b = kit.assembler(4, dy);
    const s = kit.sorter(onSlot(a, 4), onSlot(b, 10), 1);
    return { kit, s };
  }

  test('pass: aligned buildings, and a lateral offset of 0.5 tile (12.6 degrees, within 14)', () => {
    expect(only(check(pair(0).kit), 'SORTER_SKEW')).toEqual([]);
    expect(only(check(pair(0.5).kit), 'SORTER_SKEW')).toEqual([]);
  });

  test('fail: a lateral offset of 0.6 tile is 15 degrees off, naming the sorter and the angle', () => {
    const { kit, s } = pair(0.6);
    const v = only(check(kit), 'SORTER_SKEW');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toContainEqual({ kind: 'sorter', id: s.id });
    expect(v[0].message).toContain(`sorter ${s.id}`);
    expect(v[0].message).toMatch(/15\.\d degrees/);
    expect(v[0].message).toMatch(/14/);
    expect(v[0].mirrors).toBe('BuildTool_Inserter.CheckBuildConditions');
  });

  test('fail: a whole tile of lateral offset', () => {
    expect(only(check(pair(1).kit), 'SORTER_SKEW')).toHaveLength(1);
  });

  test('fail with a belt (limit 11 degrees): the belt runs along the facing, the ends have no sensible direction', () => {
    const { kit, asm } = lone();
    // Slot 4 (east, middle, lateral 0): an east-west belt on y = 0 projects its end onto the slot itself.
    const belt = kit.belt(1, 1001, line([4, 0], [0, 0]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 4), 1); // node 2 = (2, 0)
    const v = only(check(kit), 'SORTER_SKEW');
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/no horizontal direction|11/);
  });

  test('fail with a belt: a belt row a lattice step off the slot row points the sorter sideways', () => {
    const { kit, asm } = lone();
    // Slot 3 sits at y = 0.796; an east-west belt on y = 1 puts the belt end 0.2 tile beside the slot: 90 degrees off.
    const belt = kit.belt(1, 1001, line([4, 1], [0, 1]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3), 1);
    const v = only(check(kit), 'SORTER_SKEW');
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/11/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('11 SORTER_IN_BUILDING', () => {
  test('pass: a span-3 sorter over free lattice points (the footprint of its own building is not an obstacle)', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([4, -1], [4, 3]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3), 3);
    expect(only(check(kit), 'SORTER_IN_BUILDING')).toEqual([]);
  });

  test('fail: another building on a lattice point between the ends', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([4, -1], [4, 3]));
    const s = kit.sorter(onNode(belt, 2), onSlot(asm, 3), 3);
    const tower = kit.tesla(3, 1); // on the lattice point (3, 1), strictly between the ends
    const v = only(check(kit), 'SORTER_IN_BUILDING');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'sorter', id: s.id },
      { kind: 'building', id: tower.id },
    ]);
    expect(v[0].message).toContain(`sorter ${s.id}`);
    expect(v[0].message).toContain(`building ${tower.id}`);
    expect(v[0].mirrors).toBe('BuildTool_Inserter.CheckBuildConditions');
  });

  test('a building off the sorter\'s line is no obstacle', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([4, -1], [4, 3]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3), 3);
    kit.tesla(3, 2.5);
    expect(only(check(kit), 'SORTER_IN_BUILDING')).toEqual([]);
  });

  test('fail: a building between two buildings (building to building sorter)', () => {
    const kit = new LayoutKit();
    const a = kit.assembler(0, 0);
    const b = kit.assembler(5, 0);
    kit.sorter(onSlot(a, 4), onSlot(b, 10), 2);
    kit.tesla(3, 0);
    expect(only(check(kit), 'SORTER_IN_BUILDING')).toHaveLength(1);
  });

  test('a building above the sorter\'s height is not in its way', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([4, -1], [4, 3]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3), 3);
    kit.building(ITEM.assembler, 3, 1, 0, { z: 5 });
    expect(only(check(kit), 'SORTER_IN_BUILDING')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('absurd coordinates', () => {
  test('a sorter whose belt end is a billion tiles away is reported as out of reach, quickly', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, [[1e9, 0], [1e9, 1], [1e9, 2]]);
    kit.sorter(onNode(belt, 1), onSlot(asm, 3));
    const t0 = performance.now();
    const v = check(kit);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(only(v, 'SORTER_SPAN').some((x) => /reach/.test(x.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('12 SORTER_ENDPOINT_BELT_RAMP', () => {
  test('pass: a tap on a flat ground stretch', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3));
    expect(only(check(kit), 'SORTER_ENDPOINT_BELT_RAMP')).toEqual([]);
  });

  test('fail: the tap node is above the ground (a floating belt)', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -1], [2, 3], 1));
    const s = kit.sorter(onNode(belt, 2), onSlot(asm, 3));
    const v = only(check(kit), 'SORTER_ENDPOINT_BELT_RAMP');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'sorter', id: s.id },
      { kind: 'belt', id: belt.id, node: 2 },
    ]);
    expect(v[0].message).toContain(`sorter ${s.id}`);
    expect(v[0].message).toContain(`belt ${belt.id}`);
    expect(v[0].mirrors).toBe('BuildTool_Inserter.CheckBuildConditions');
  });

  test('fail: a neighbouring node of the tap changes height (the lift starts next to the tap)', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, [[2, -2, 0], [2, -1, 0], [2, 0, 0], [2, 1, 0], [2, 1, 1], [2, 2, 1], [2, 3, 1]]);
    kit.sorter(onNode(belt, 3), onSlot(asm, 3));
    expect(only(check(kit), 'SORTER_ENDPOINT_BELT_RAMP')).toHaveLength(1);
  });

  test('pass: a ramp two nodes away from the tap is allowed', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, [[2, -2, 0], [2, -1, 0], [2, 0, 0], [2, 1, 0], [2, 2, 0], [2, 2, 1], [2, 3, 1], [2, 4, 1]]);
    kit.sorter(onNode(belt, 3), onSlot(asm, 3));
    expect(only(check(kit), 'SORTER_ENDPOINT_BELT_RAMP')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('12a SORTER_BELT_TANGENT', () => {
  test('pass: the tap is mid-straight and the belt runs across the facing (the composite)', () => {
    expect(only(check(compositeLayout().kit), 'SORTER_BELT_TANGENT')).toEqual([]);
  });

  test('fail: the tap is on a corner of the belt', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, [[2, -1], [2, 0], [2, 1], [3, 1], [4, 1]]);
    const s = kit.sorter(onNode(belt, 2), onSlot(asm, 3));
    const v = only(check(kit), 'SORTER_BELT_TANGENT');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'sorter', id: s.id },
      { kind: 'belt', id: belt.id, node: 2 },
    ]);
    expect(v[0].message).toContain(`sorter ${s.id}`);
    expect(v[0].message).toMatch(/corner|straight/);
    expect(v[0].mirrors).toBe('BuildTool_Inserter.CheckBuildConditions');
  });

  test('fail: the tap is the first node of the belt (no previous node)', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, 1], [2, 4]));
    kit.sorter(onNode(belt, 0), onSlot(asm, 3), 1);
    const v = only(check(kit), 'SORTER_BELT_TANGENT');
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/previous/);
  });

  test('fail: the tap is the last node of the belt (no next node)', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([2, -2], [2, 1]));
    kit.sorter(onNode(belt, 3), onSlot(asm, 3), 1);
    const v = only(check(kit), 'SORTER_BELT_TANGENT');
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/next/);
  });

  test('fail: the belt runs along the slot facing instead of across it', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, line([4, 1], [0, 1]));
    kit.sorter(onNode(belt, 2), onSlot(asm, 3), 1); // node 2 = (2, 1), belt axis east-west, slot faces east
    const v = only(check(kit), 'SORTER_BELT_TANGENT');
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/perpendicular/);
  });

  test('a corner with no perpendicular segment (diagonal steps) is reported, not thrown', () => {
    const { kit, asm } = lone();
    const belt = kit.belt(1, 1001, [[1, 0], [2, 1], [1, 2]]);
    kit.sorter(onNode(belt, 1), onSlot(asm, 3));
    expect(() => check(kit)).not.toThrow();
    expect(only(check(kit), 'SORTER_BELT_TANGENT')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('13 SORTER_TO_STATION', () => {
  test('pass: sorters on production buildings only (the composite)', () => {
    expect(only(check(compositeLayout().kit), 'SORTER_TO_STATION')).toEqual([]);
  });

  test.each(['pick', 'drop'] as const)('fail: a sorter %s on a station, naming sorter and station', (end) => {
    const kit = new LayoutKit();
    const station = kit.station(0, 0);
    const asm = kit.assembler(8, 0);
    const toStation = onSlot(station, 0);
    const s = end === 'pick' ? kit.sorter(toStation, onSlot(asm, 10), 2) : kit.sorter(onSlot(asm, 10), toStation, 2);
    const v = only(check(kit), 'SORTER_TO_STATION');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([
      { kind: 'sorter', id: s.id },
      { kind: 'building', id: station.id },
    ]);
    expect(v[0].message).toContain(`sorter ${s.id}`);
    expect(v[0].message).toContain(`building ${station.id}`);
    expect(v[0].mirrors).toBe('BuildTool_Inserter.CheckBuildConditions');
  });

  test('a sorter on a station is reported once, not also as a bad slot', () => {
    const kit = new LayoutKit();
    const station = kit.station(0, 0);
    const asm = kit.assembler(8, 0);
    kit.sorter(onSlot(station, 0), onSlot(asm, 10), 2);
    const codes = codesOf(check(kit)).filter((c) => c.startsWith('SORTER_'));
    expect(codes).toEqual(['SORTER_TO_STATION']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('14 POWER_UNCOVERED', () => {
  const cover = 10.5 / TILE; // the Tesla tower's cover radius in tiles: 8.356

  test('pass: consumers (buildings and sorters) inside the cover radius', () => {
    expect(only(check(compositeLayout().kit), 'POWER_UNCOVERED')).toEqual([]);
  });

  test('a building is measured at its centre against the tower\'s power point, in metres', () => {
    const inside = new LayoutKit();
    powered(inside, 0, 0);
    inside.assembler(cover - 0.05, 0);
    expect(only(check(inside), 'POWER_UNCOVERED')).toEqual([]);

    const outside = new LayoutKit();
    powered(outside, 0, 0);
    const asm = outside.assembler(cover + 0.05, 0);
    const v = only(check(outside), 'POWER_UNCOVERED');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([{ kind: 'building', id: asm.id }]);
    expect(v[0].message).toContain(`building ${asm.id}`);
    expect(v[0].message).toMatch(/10\.5 m/);
    expect(v[0].mirrors).toBe('PowerSystem.GameTick');
  });

  test('fail: a sorter is a consumer measured at the midpoint of its ends', () => {
    const kit = new LayoutKit();
    const asm = kit.assembler(0, 0);
    // The assembler centre is 8.2 tiles from the tower, the midpoint of a span-3 sorter on slot 3 is 10.6 tiles.
    kit.tesla(-8.2, 0);
    const belt = kit.belt(1, 1001, line([4, -1], [4, 3]));
    const s = kit.sorter(onNode(belt, 2), onSlot(asm, 3), 3);
    const v = only(check(kit), 'POWER_UNCOVERED');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([{ kind: 'sorter', id: s.id }]);
    expect(v[0].message).toContain(`sorter ${s.id}`);
  });

  test('a sorter is covered when the midpoint of its ends is, whichever end is out of range', () => {
    // Span-3 sorter on slot 3: ends at x = 0.883 (slot) and x = 4 (belt), midpoint x = 2.44, row y = 0.796.
    for (const towerX of [-4.5, 10.74]) {
      const kit = new LayoutKit();
      const asm = kit.assembler(0, 0);
      kit.tesla(towerX, 0.8);
      const belt = kit.belt(1, 1001, line([4, -1], [4, 3]));
      kit.sorter(onNode(belt, 2), onSlot(asm, 3), 3);
      const uncovered = only(check(kit), 'POWER_UNCOVERED');
      expect(uncovered.filter((v) => v.entities[0].kind === 'sorter'), `tower at x ${towerX}`).toEqual([]);
    }
  });

  test('fail: with no power node every consumer is uncovered; belts and towers are not consumers', () => {
    const kit = new LayoutKit();
    const a = kit.assembler(0, 0);
    const station = kit.station(10, 0);
    kit.belt(1, 1001, line([0, 5], [4, 5]));
    const v = only(check(kit), 'POWER_UNCOVERED');
    expect(v.map((x) => x.entities[0])).toEqual([
      { kind: 'building', id: a.id },
      { kind: 'building', id: station.id },
    ]);
  });

  test('a tower with no cover radius (solar panel) does not cover anything', () => {
    const kit = new LayoutKit();
    kit.building(2205, 0, 0);
    kit.assembler(3, 0);
    expect(only(check(kit), 'POWER_UNCOVERED')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('15 POWER_DISCONNECTED', () => {
  const reach = 22.5 / TILE; // the Tesla tower's connect distance in tiles: 17.905

  test('pass: one node, and two within reach', () => {
    const one = new LayoutKit();
    one.tesla(0, 0);
    expect(only(check(one), 'POWER_DISCONNECTED')).toEqual([]);

    const two = new LayoutKit();
    two.tesla(0, 0);
    two.tesla(reach - 0.1, 0);
    expect(only(check(two), 'POWER_DISCONNECTED')).toEqual([]);
  });

  test('pass: a chain connects through a middle tower even when the ends are too far apart', () => {
    const kit = new LayoutKit();
    kit.tesla(0, 0);
    kit.tesla(reach - 0.5, 0);
    kit.tesla(2 * (reach - 0.5), 0);
    expect(only(check(kit), 'POWER_DISCONNECTED')).toEqual([]);
  });

  test('fail: two towers out of reach, naming the stranded tower and the rule', () => {
    const kit = new LayoutKit();
    const a = kit.tesla(0, 0);
    const b = kit.tesla(reach + 0.1, 0);
    const v = only(check(kit), 'POWER_DISCONNECTED');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([{ kind: 'building', id: b.id }]);
    expect(v[0].message).toContain(`building ${b.id}`);
    expect(v[0].message).toContain(`building ${a.id}`);
    expect(v[0].message).toMatch(/min\(connectDistance/);
    expect(v[0].message).toMatch(/C3/);
    expect(v[0].mirrors).toBe('PowerSystem.GameTick');
  });

  test('the link needs the smaller connectDistance: a Tesla (22.5 m) and a Wireless Tower (45.5 m) 30 m apart are not linked', () => {
    const kit = new LayoutKit();
    kit.tesla(0, 0);
    kit.building(ITEM.wirelessTower, 30 / TILE, 0);
    expect(only(check(kit), 'POWER_DISCONNECTED')).toHaveLength(1);

    const near = new LayoutKit();
    near.tesla(0, 0);
    near.building(ITEM.wirelessTower, 20 / TILE, 0);
    expect(only(check(near), 'POWER_DISCONNECTED')).toEqual([]);
  });

  test('every stranded group is one violation listing its towers; the biggest group (first on ties) is the main network', () => {
    const kit = new LayoutKit();
    kit.tesla(0, 0);
    kit.tesla(5, 0);
    const far1 = kit.tesla(40, 0);
    const far2 = kit.tesla(40, 10);
    const lone3 = kit.tesla(0, 60);
    const v = only(check(kit), 'POWER_DISCONNECTED');
    expect(v).toHaveLength(2);
    expect(v[0].entities).toEqual([
      { kind: 'building', id: far1.id },
      { kind: 'building', id: far2.id },
    ]);
    expect(v[1].entities).toEqual([{ kind: 'building', id: lone3.id }]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('16 STATION_SLOTS', () => {
  test('pass: as many item kinds as the station allows (ILS 5, PLS 4) and ports within the slots', () => {
    const kit = new LayoutKit();
    for (const [item, kinds] of [
      [ITEM.ils, 5],
      [ITEM.pls, 4],
    ] as const) {
      const st = kit.station(item === ITEM.ils ? 0 : 20, 0, 0, item);
      st.station!.slots = Array.from({ length: kinds }, (_, i) => ({ itemId: 1001 + i, localLogic: 1, remoteLogic: 0, max: 100 }));
      st.station!.ports[5] = { dir: 1, storageIdx: kinds };
    }
    expect(only(check(kit), 'STATION_SLOTS')).toEqual([]);
  });

  test('fail: more slots than maxItemKinds (an ILS with six, a PLS with five)', () => {
    for (const [item, kinds, name] of [
      [ITEM.ils, 6, 'Interstellar'],
      [ITEM.pls, 5, 'Planetary'],
    ] as const) {
      const kit = new LayoutKit();
      const st = kit.station(0, 0, 0, item);
      st.station!.slots = Array.from({ length: kinds }, (_, i) => ({ itemId: 1001 + i, localLogic: 1, remoteLogic: 0, max: 100 }));
      const v = only(check(kit), 'STATION_SLOTS');
      expect(v, name).toHaveLength(1);
      expect(v[0].entities).toEqual([{ kind: 'building', id: st.id }]);
      expect(v[0].message).toContain(`building ${st.id}`);
      expect(v[0].message).toContain(String(kinds));
    }
  });

  test('fail: a port that outputs a slot beyond the configured slots', () => {
    const kit = new LayoutKit();
    const st = kit.station(0, 0);
    st.station!.ports[3] = { dir: 1, storageIdx: 2 }; // the station has one slot
    const v = only(check(kit), 'STATION_SLOTS');
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/port 3/);
    expect(v[0].message).toMatch(/storageIdx 2/);
  });

  test('pass: storageIdx 0 means no slot', () => {
    const kit = new LayoutKit();
    const st = kit.station(0, 0);
    st.station!.ports[3] = { dir: 2, storageIdx: 0 };
    expect(only(check(kit), 'STATION_SLOTS')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('output', () => {
  test('violations come out grouped by rule in the order of the rule list', () => {
    const kit = new LayoutKit();
    kit.assembler(0, 0);
    kit.assembler(2, 0); // BUILDING_OVERLAP
    kit.belt(1, 1001, [[0, 0], [5, 0]]); // BELT_IN_BUILDING, BELT_DISCONNECTED
    const codes = codesOf(check(kit));
    const first = (c: ViolationCode) => codes.indexOf(c);
    expect(first('BUILDING_OVERLAP')).toBeLessThan(first('BELT_IN_BUILDING'));
    expect(first('BELT_IN_BUILDING')).toBeLessThan(first('BELT_DISCONNECTED'));
    expect(first('BELT_DISCONNECTED')).toBeLessThan(first('POWER_UNCOVERED'));
  });

  test('the checker does not edit the layout', () => {
    const c = compositeLayout();
    const before = JSON.stringify(c.kit.layout());
    check(c.kit);
    expect(JSON.stringify(c.kit.layout())).toBe(before);
  });
});

describe('performance', () => {
  test('about 1,200 assemblers, 2,400 sorters, 7,000 belt nodes and 900 towers in well under a second, and clean', () => {
    const kit = new LayoutKit();
    const rows = 30;
    const cols = 40;
    for (let r = 0; r < rows; r++) {
      const beltY = 12 * r + 6;
      const belt = kit.belt(2, 1001, line([0, beltY], [6 * cols, beltY]));
      for (let c = 0; c < cols; c++) {
        const x = 6 * c + 3;
        const asm = kit.assembler(x, 12 * r + 8);
        kit.sorter(onNode(belt, x), onSlot(asm, 7), 1); // belt to the south face middle slot, tap (x, beltY)
        kit.sorter(onSlot(asm, 6), onNode(belt, x + 1), 1); // the south face east slot, tap (x + 1, beltY)
      }
      for (let k = 0; k < (6 * cols) / 8; k++) kit.tesla(8 * k + 4, 12 * r + 2);
    }
    const layout = kit.layout();
    expect(layout.buildings.length).toBeGreaterThan(2000);
    expect(layout.sorters.length).toBe(2400);

    const t0 = performance.now();
    const violations = checkGeometry(layout, kit.data, kit.effects);
    const ms = performance.now() - t0;
    console.log(`checkGeometry: ${layout.buildings.length} buildings, ${layout.belts.reduce((n, b) => n + b.nodes.length, 0)} belt nodes, ${layout.sorters.length} sorters in ${ms.toFixed(0)} ms`);
    expect(violations).toEqual([]);
    expect(ms).toBeLessThan(1000);
  });
});
