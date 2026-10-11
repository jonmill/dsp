import { describe, expect, it } from 'vitest';
import { GameDataIndex } from '../data';
import { buildingOBBs, obbOverlap, pointInOBBs, BELT_HALF_WIDTH_TILES } from '../geometry';
import type { PlacedBuilding, Yaw } from '../geometry';
import { loadFixtureGameData } from '../../../test/fixtures/fixtureGameData';
import { Occupancy } from './occupancy';
import { Rng } from './rng';

const data = new GameDataIndex(loadFixtureGameData());

const ASSEMBLER = 2303;
const SMELTER = 2302;
const PLS = 2103;
const CHEM_PLANT = 2309;
const SILO = 2312;

const bld = (id: number, itemId: number, x: number, y: number, yaw: Yaw = 0, z = 0): PlacedBuilding => ({
  id,
  itemId,
  x,
  y,
  z,
  yaw,
});

function occupancyOf(...bs: PlacedBuilding[]): Occupancy {
  const occ = new Occupancy(data);
  for (const b of bs) occ.addBuilding(b);
  return occ;
}

describe('blockedForBelt', () => {
  it('an assembler blocks belts at its centre and at +-1, but not at +-2', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0));
    for (const [x, y] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      expect(occ.blockedForBelt(x, y, 0), `(${x}, ${y})`).toBe(true);
    }
    for (const [x, y] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [3, 0]]) {
      expect(occ.blockedForBelt(x, y, 0), `(${x}, ${y})`).toBe(false);
    }
  });

  it('a station (+-4 m) blocks +-3 and not +-4, and leaves the corners of its cross free', () => {
    const occ = occupancyOf(bld(1, PLS, 0, 0));
    for (const [x, y] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [3, 1], [1, 3]]) {
      expect(occ.blockedForBelt(x, y, 0), `(${x}, ${y})`).toBe(true);
    }
    for (const [x, y] of [[4, 0], [-4, 0], [0, 4], [0, -4], [2, 2], [3, 2], [-3, -2]]) {
      expect(occ.blockedForBelt(x, y, 0), `(${x}, ${y})`).toBe(false);
    }
  });

  it('inflates by the belt half width: a point just inside the inflated face is blocked, just outside is not', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0));
    const face = buildingOBBs(bld(1, ASSEMBLER, 0, 0), data.building(ASSEMBLER)!)[0].hx;
    expect(occ.blockedForBelt(face + BELT_HALF_WIDTH_TILES - 0.01, 0, 0)).toBe(true);
    expect(occ.blockedForBelt(face + BELT_HALF_WIDTH_TILES + 0.01, 0, 0)).toBe(false);
  });

  it('respects height: a belt on the roof or below the floor is free, one at ground level is blocked', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0));
    const top = buildingOBBs(bld(1, ASSEMBLER, 0, 0), data.building(ASSEMBLER)!)[0].zMax;
    expect(occ.blockedForBelt(0, 0, 0)).toBe(true);
    expect(occ.blockedForBelt(0, 0, Math.floor(top) - 1)).toBe(true);
    expect(occ.blockedForBelt(0, 0, Math.ceil(top) + 1)).toBe(false);
    expect(occ.blockedForBelt(0, 0, -1)).toBe(false);
  });

  it('follows the yaw of an asymmetric building', () => {
    // the chemical plant is wider along x (3.8 tiles) than y (2.7 tiles); a quarter turn swaps them
    const at0 = occupancyOf(bld(1, CHEM_PLANT, 0, 0, 0));
    const at90 = occupancyOf(bld(1, CHEM_PLANT, 0, 0, 90));
    expect(at0.blockedForBelt(4, 0, 0)).toBe(true);
    expect(at0.blockedForBelt(0, -3, 0)).toBe(false);
    expect(at90.blockedForBelt(4, 0, 0)).toBe(false);
    expect(at90.blockedForBelt(0, -3, 0)).toBe(true);
  });
});

describe('buildingCollides', () => {
  it('two assemblers 4 apart do not collide; 3 apart do', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0));
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 4, 0))).toBe(false);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 3, 0))).toBe(true);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 0, 4))).toBe(false);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 0, -3))).toBe(true);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 3, 3))).toBe(true);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 4, 4))).toBe(false);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 0, 0))).toBe(true);
  });

  it('a building does not collide with itself: an indexed building with the same id is ignored', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0));
    expect(occ.buildingCollides(bld(1, ASSEMBLER, 1, 0))).toBe(false);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 1, 0))).toBe(true);
  });

  it('margin grows the clearance: the footprints must stay 2 * margin tiles apart', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0));
    // faces at +-1.59: 5 apart leaves a gap of 1.82, 6 apart 2.82, 8 apart 4.82
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 5, 0), 0)).toBe(false);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 5, 0), 1)).toBe(true);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 6, 0), 1)).toBe(false);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 6, 0), 2)).toBe(true);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 8, 0), 2)).toBe(false);
    // the grown footprint keeps square corners: a diagonal neighbour is clear once either axis has the gap
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 5, 5), 1)).toBe(true);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 6, 3), 1)).toBe(false);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 2, 6), 1)).toBe(false);
  });

  it('the margin is symmetric: it does not matter which of the two is indexed', () => {
    const a = bld(1, SMELTER, 0, 0);
    const b = bld(2, CHEM_PLANT, 7, 1, 90);
    for (const margin of [0, 1, 2, 3]) {
      expect(occupancyOf(a).buildingCollides(b, margin)).toBe(occupancyOf(b).buildingCollides(a, margin));
    }
  });

  it('skips the ignored ids', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0), bld(2, ASSEMBLER, 10, 0));
    const probe = bld(3, ASSEMBLER, 1, 0);
    expect(occ.buildingCollides(probe)).toBe(true);
    expect(occ.buildingCollides(probe, 0, new Set([1]))).toBe(false);
    expect(occ.buildingCollides(bld(3, ASSEMBLER, 9, 0), 0, new Set([1]))).toBe(true);
    expect(occ.buildingCollides(bld(3, ASSEMBLER, 9, 0), 0, new Set([1, 2]))).toBe(false);
  });

  it('finds a building across spatial hash cells (a large silo, far corners)', () => {
    const occ = occupancyOf(bld(1, SILO, 0, 0));
    // the silo reaches +-6.9 by +-7.7 tiles
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 7, 7))).toBe(true);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, -7, 7))).toBe(true);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 9, 0))).toBe(false);
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 0, -10))).toBe(false);
    expect(occ.blockedForBelt(6, -7, 0)).toBe(true);
    expect(occ.blockedForBelt(8, 0, 0)).toBe(false);
  });

  it('detects the arms of a cross-shaped station, not its empty corners', () => {
    const occ = occupancyOf(bld(1, PLS, 0, 0));
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 4, 0))).toBe(true); // reaches into the +x arm (to 3.18)
    expect(occ.buildingCollides(bld(2, ASSEMBLER, 5, 0))).toBe(false);
    expect(occ.buildingCollides(bld(2, SMELTER, 3, 3))).toBe(false); // the corner of the cross is empty
    expect(occ.buildingCollides(bld(2, SMELTER, 3, 2))).toBe(true);
  });

  it('agrees with a brute-force OBB test on random layouts', () => {
    const rng = new Rng(11);
    const items = [ASSEMBLER, SMELTER, CHEM_PLANT, PLS, SILO];
    const yaws: Yaw[] = [0, 90, 180, 270];
    const pick = (id: number): PlacedBuilding =>
      bld(id, items[rng.int(items.length)], rng.int(81) - 40, rng.int(81) - 40, yaws[rng.int(4)]);
    const placed: PlacedBuilding[] = [];
    for (let i = 1; i <= 80; i++) placed.push(pick(i));
    const occ = occupancyOf(...placed);
    const obbsOf = (b: PlacedBuilding) => buildingOBBs(b, data.building(b.itemId)!);
    const placedObbs = placed.map(obbsOf);

    for (let t = 0; t < 300; t++) {
      const probe = pick(1000 + t);
      const margin = rng.int(3);
      const mine = obbsOf(probe);
      const expected = placedObbs.some((others) =>
        mine.some((a) => others.some((c) => obbOverlap({ ...a, hx: a.hx + 2 * margin, hy: a.hy + 2 * margin }, c))),
      );
      expect(occ.buildingCollides(probe, margin), `probe ${t}`).toBe(expected);

      const x = rng.int(97) - 48;
      const y = rng.int(97) - 48;
      const blocked = placedObbs.some((o) => pointInOBBs(x, y, 0, o, BELT_HALF_WIDTH_TILES));
      expect(occ.blockedForBelt(x, y, 0), `point ${x},${y}`).toBe(blocked);
    }
  });
});

describe('add and remove', () => {
  it('removeBuilding frees the space and reports whether the building was indexed', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0), bld(2, ASSEMBLER, 10, 0));
    expect(occ.blockedForBelt(0, 0, 0)).toBe(true);
    expect(occ.removeBuilding(1)).toBe(true);
    expect(occ.blockedForBelt(0, 0, 0)).toBe(false);
    expect(occ.buildingCollides(bld(3, ASSEMBLER, 0, 0))).toBe(false);
    expect(occ.blockedForBelt(10, 0, 0)).toBe(true);
    expect(occ.removeBuilding(1)).toBe(false);
    expect(occ.removeBuilding(99)).toBe(false);
  });

  it('a removed building can be added again at another place', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0));
    occ.removeBuilding(1);
    occ.addBuilding(bld(1, ASSEMBLER, 20, 20));
    expect(occ.blockedForBelt(0, 0, 0)).toBe(false);
    expect(occ.blockedForBelt(20, 20, 0)).toBe(true);
  });

  it('rejects a duplicate id and a building GameData does not know', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0));
    expect(() => occ.addBuilding(bld(1, ASSEMBLER, 9, 9))).toThrow(/building 1/);
    expect(() => occ.addBuilding(bld(2, 424242, 0, 0))).toThrow(/424242/);
  });

  it('copes with buildings at negative and fractional coordinates', () => {
    const occ = occupancyOf(bld(1, ASSEMBLER, -17.5, -33.5), bld(2, SMELTER, 0.5, -0.5));
    expect(occ.blockedForBelt(-17, -33, 0)).toBe(true);
    expect(occ.blockedForBelt(-17, -36, 0)).toBe(false);
    expect(occ.buildingCollides(bld(3, ASSEMBLER, -17.5, -30.5))).toBe(true);
    expect(occ.buildingCollides(bld(3, ASSEMBLER, -17.5, -29.5))).toBe(false);
  });
});

describe('bounds', () => {
  it('is all zeros when nothing is indexed', () => {
    expect(new Occupancy(data).bounds()).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it('spans the footprints, follows removals, and uses the turned footprint', () => {
    const half = buildingOBBs(bld(1, ASSEMBLER, 0, 0), data.building(ASSEMBLER)!)[0].hx;
    const occ = occupancyOf(bld(1, ASSEMBLER, 0, 0), bld(2, ASSEMBLER, 10, -6));
    const b = occ.bounds();
    expect(b.minX).toBeCloseTo(-half, 9);
    expect(b.maxX).toBeCloseTo(10 + half, 9);
    expect(b.minY).toBeCloseTo(-6 - half, 9);
    expect(b.maxY).toBeCloseTo(half, 9);
    occ.removeBuilding(2);
    expect(occ.bounds().maxX).toBeCloseTo(half, 9);
    occ.addBuilding(bld(3, CHEM_PLANT, 0, 30, 90));
    const turned = buildingOBBs(bld(3, CHEM_PLANT, 0, 30, 90), data.building(CHEM_PLANT)!)[0];
    const reach = Math.abs(Math.sin(turned.angle)) * turned.hx + Math.abs(Math.cos(turned.angle)) * turned.hy;
    expect(occ.bounds().maxY).toBeCloseTo(turned.cy + reach, 9);
  });
});

describe('obbsOf', () => {
  it('equals the geometry kernel footprint at any position and yaw', () => {
    const occ = new Occupancy(data);
    const yaws: Yaw[] = [0, 90, 180, 270];
    for (const itemId of [ASSEMBLER, CHEM_PLANT, PLS, SILO]) {
      for (const yaw of yaws) {
        for (const [x, y, z] of [[0, 0, 0], [13, -7, 0], [-4.5, 2.5, 2]]) {
          const b = bld(1, itemId, x, y, yaw, z);
          const direct = buildingOBBs(b, data.building(itemId)!);
          const cached = occ.obbsOf(b);
          expect(cached.length).toBe(direct.length);
          direct.forEach((d, i) => {
            for (const key of ['cx', 'cy', 'hx', 'hy', 'angle', 'zMin', 'zMax'] as const) {
              expect(cached[i][key]).toBeCloseTo(d[key], 9);
            }
          });
        }
      }
    }
  });
});
