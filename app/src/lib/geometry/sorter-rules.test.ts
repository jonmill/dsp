import { describe, expect, test } from 'vitest';
import { GameDataIndex } from '../data';
import type { Building } from '../data';
import { loadFixtureGameData } from '../../../test/fixtures/fixtureGameData';
import { slotInfos, sorterEnds, sorterTapEnds, sorterTapPoint } from './endpoints';
import type { BeltPath, Layout, PlacedBuilding, Sorter, Yaw } from './model';
import {
  MIN_SORTER_LENGTH_M,
  SKEW_LIMIT_BELT_DEG,
  SKEW_LIMIT_BUILDING_DEG,
  sorterEndsProblem,
  sorterEndsValid,
  sorterLengthMeters,
  sorterReachProblem,
  sorterSkewProblem,
} from './sorter-rules';
import { LEVEL, TILE } from './transform';

const data = new GameDataIndex(loadFixtureGameData());
const def = (itemId: number): Building => {
  const b = data.building(itemId);
  if (!b) throw new Error(`no building ${itemId}`);
  return b;
};
const REACH = data.data.constants.sorterMaxReachMeters;
const ASSEMBLER = 2303;
const COLLIDER = 2310;
const YAWS: Yaw[] = [0, 90, 180, 270];

const p = (x: number, y: number, z = 0) => ({ x, y, z });

describe('constants', () => {
  test('the limits of the game: 1 m minimum, 14 / 11 degrees, 5.5 m reach in the data', () => {
    expect(MIN_SORTER_LENGTH_M).toBe(1);
    expect(SKEW_LIMIT_BUILDING_DEG).toBe(14);
    expect(SKEW_LIMIT_BELT_DEG).toBe(11);
    expect(REACH).toBe(5.5);
  });
});

describe('sorterLengthMeters', () => {
  test('is the 3D distance, tiles and levels converted to metres', () => {
    expect(sorterLengthMeters(p(0, 0), p(1, 0))).toBeCloseTo(TILE, 12);
    expect(sorterLengthMeters(p(0, 0), p(3, 4))).toBeCloseTo(5 * TILE, 12);
    expect(sorterLengthMeters(p(0, 0, 0), p(0, 0, 3))).toBeCloseTo(3 * LEVEL, 12);
    expect(sorterLengthMeters(p(1, 1, 0), p(1 + 1 / TILE, 1, 1 / LEVEL))).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe('sorterReachProblem', () => {
  test('1 m and 5.5 m are inside, on the boundary', () => {
    expect(sorterReachProblem(p(0, 0), p(1 / TILE, 0), REACH)).toBeUndefined();
    expect(sorterReachProblem(p(0, 0), p(REACH / TILE, 0), REACH)).toBeUndefined();
  });

  test('0.777 m is too close, the number is reported', () => {
    const r = sorterReachProblem(p(0, 0), p(0.618, 0), REACH);
    expect(r?.kind).toBe('too-close');
    expect(r?.meters).toBeCloseTo(0.618 * TILE, 9);
  });

  test('beyond the reach is too far, vertical distance counts', () => {
    expect(sorterReachProblem(p(0, 0), p(5, 0), REACH)?.kind).toBe('too-far');
    expect(sorterReachProblem(p(0, 0, 0), p(2, 0, 4), REACH)?.kind).toBe('too-far');
    expect(sorterReachProblem(p(0, 0, 0), p(2, 0, 1), REACH)).toBeUndefined();
  });

  test('a short sorter can be rescued by height: it is the 3D distance that counts', () => {
    // 0.5 m along the plan, 1 level (1.33 m) up
    expect(sorterReachProblem(p(0, 0, 0), p(0.5 / TILE, 0, 1), REACH)).toBeUndefined();
  });
});

describe('sorterSkewProblem', () => {
  const east: [number, number] = [1, 0];

  test('no facings, no rule (belt to belt)', () => {
    expect(sorterSkewProblem(p(0, 0), p(3, 3), [], true)).toBeUndefined();
  });

  test('aligned or reversed along the facing is fine', () => {
    expect(sorterSkewProblem(p(0, 0), p(2, 0), [east], true)).toBeUndefined();
    expect(sorterSkewProblem(p(2, 0), p(0, 0), [east], true)).toBeUndefined();
  });

  test('11 degrees to a belt, 14 between buildings', () => {
    const at = (deg: number) => p(2 * Math.cos((deg * Math.PI) / 180), 2 * Math.sin((deg * Math.PI) / 180));
    expect(sorterSkewProblem(p(0, 0), at(10.9), [east], true)).toBeUndefined();
    const belt = sorterSkewProblem(p(0, 0), at(11.5), [east], true);
    expect(belt?.kind).toBe('skew');
    expect(belt).toMatchObject({ limitDeg: 11, facing: 0 });
    expect(belt?.kind === 'skew' && belt.degrees).toBeCloseTo(11.5, 6);
    expect(sorterSkewProblem(p(0, 0), at(13.9), [east, east], false)).toBeUndefined();
    expect(sorterSkewProblem(p(0, 0), at(14.5), [east, east], false)).toMatchObject({ kind: 'skew', limitDeg: 14 });
  });

  test('names the facing that is worst off', () => {
    const north: [number, number] = [0, 1];
    // direction east: 0 degrees off the east facing, 90 off the north one
    expect(sorterSkewProblem(p(0, 0), p(2, 0), [east, north], false)).toMatchObject({ kind: 'skew', facing: 1 });
  });

  test('ends at one point in the plan have no direction', () => {
    expect(sorterSkewProblem(p(1, 1, 0), p(1, 1, 2), [east], true)).toEqual({ kind: 'no-direction', limitDeg: 11 });
    expect(sorterSkewProblem(p(1, 1, 0), p(1, 1, 2), [east, east], false)).toEqual({ kind: 'no-direction', limitDeg: 14 });
  });
});

describe('sorterEndsProblem and sorterEndsValid', () => {
  const east: [number, number] = [1, 0];

  test('valid: a straight sorter of 2 tiles', () => {
    const ends = { pick: p(0, 0), drop: p(2, 0), facings: [east], toBelt: true };
    expect(sorterEndsProblem(ends, REACH)).toBeUndefined();
    expect(sorterEndsValid(ends, REACH)).toBe(true);
  });

  test('invalid: too close, too far, skew', () => {
    expect(sorterEndsValid({ pick: p(0, 0), drop: p(0.6, 0), facings: [east], toBelt: true }, REACH)).toBe(false);
    expect(sorterEndsProblem({ pick: p(0, 0), drop: p(0.6, 0), facings: [east], toBelt: true }, REACH)?.kind).toBe('too-close');
    expect(sorterEndsProblem({ pick: p(0, 0), drop: p(6, 0), facings: [east], toBelt: true }, REACH)?.kind).toBe('too-far');
    expect(sorterEndsProblem({ pick: p(0, 0), drop: p(2, 2), facings: [east], toBelt: true }, REACH)?.kind).toBe('skew');
  });

  test('a too-far sorter is reported as too far, before any skew', () => {
    expect(sorterEndsProblem({ pick: p(0, 0), drop: p(6, 6), facings: [east], toBelt: true }, REACH)?.kind).toBe('too-far');
  });
});

describe('sorterTapEnds: the ends a tap makes, from the slot and the tap point alone', () => {
  const ground = (id: number, nodes: [number, number][]): BeltPath => ({
    id,
    tierItemId: 2001,
    itemId: 1001,
    nodes: nodes.map(([x, y]) => ({ x, y, z: 0 })),
    plannedRate: 1,
  });
  const layoutOf = (b: PlacedBuilding, belt: BeltPath, sorter: Sorter): Layout => ({
    buildings: [b],
    belts: [belt],
    sorters: [sorter],
    meta: { geometrySource: 'approximate', gameVersion: '0.10.29.22015', planTargetItemId: 1101, planTargetRate: 1 },
  });

  for (const itemId of [ASSEMBLER, COLLIDER]) {
    test(`building ${itemId}: equals sorterEnds of a layout with a belt through the tap point, any slot, span, yaw, direction`, () => {
      for (const yaw of YAWS) {
        for (const [x, y] of [[0, 0], [0.5, 0.5], [0.25, -0.75]]) {
          const b: PlacedBuilding = { id: 1, itemId, x, y, z: 0, yaw };
          for (const slot of slotInfos(b, def(itemId))) {
            for (const span of [1, 2, 3] as const) {
              const tap = sorterTapPoint(slot, span);
              // a belt along the axis across the facing, through the tap point
              const along = slot.dir[0] !== 0 ? [0, 1] : [1, 0];
              const nodes: [number, number][] = [-1, 0, 1].map((k) => [tap.x + k * along[0], tap.y + k * along[1]]);
              for (const dir of ['in', 'out'] as const) {
                const onMachine = { kind: 'building', buildingId: 1, slot: slot.index } as const;
                const onBelt = { kind: 'belt', beltId: 7, node: 1 } as const;
                const sorter: Sorter = {
                  id: 1,
                  tierItemId: 2011,
                  filterItemId: 1001,
                  span,
                  plannedRate: 1,
                  pick: dir === 'out' ? onMachine : onBelt,
                  drop: dir === 'out' ? onBelt : onMachine,
                };
                const layout = layoutOf(b, ground(7, nodes), sorter);
                const want = sorterEnds(sorter, layout, data);
                const got = sorterTapEnds(slot, tap, dir);
                const label = `yaw ${yaw} at (${x}, ${y}) slot ${slot.index} span ${span} ${dir}`;
                expect(got.pick.x, label).toBeCloseTo(want.pick.x, 12);
                expect(got.pick.y, label).toBeCloseTo(want.pick.y, 12);
                expect(got.pick.z, label).toBeCloseTo(want.pick.z, 12);
                expect(got.drop.x, label).toBeCloseTo(want.drop.x, 12);
                expect(got.drop.y, label).toBeCloseTo(want.drop.y, 12);
                expect(got.drop.z, label).toBeCloseTo(want.drop.z, 12);
              }
            }
          }
        }
      }
    });
  }

  test('a Miniature Particle Collider at the origin: span 1 on the east slots is 0.777 m long, span 2 is long enough', () => {
    const b: PlacedBuilding = { id: 1, itemId: COLLIDER, x: 0, y: 0, z: 0, yaw: 0 };
    const slot = slotInfos(b, def(COLLIDER))[3];
    const length = (span: 1 | 2 | 3): number => {
      const { pick, drop } = sorterTapEnds(slot, sorterTapPoint(slot, span), 'out');
      return sorterLengthMeters(pick, drop);
    };
    expect(length(1)).toBeCloseTo(0.777, 3);
    expect(length(2)).toBeGreaterThanOrEqual(MIN_SORTER_LENGTH_M);
  });
});
