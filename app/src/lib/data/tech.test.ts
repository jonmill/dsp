import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGameData } from './load';
import type { GameData, Tech } from './schema';
import { allTechs, computeTechEffects, techClosure } from './tech';

const fixturePath = fileURLToPath(new URL('../../../../data/fixture/dsp-fixture.json', import.meta.url));
const data = parseGameData(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown, 'dsp-fixture.json');

/** A tech with no prerequisites, recipes or functions, overridden by `over`. */
function tech(id: number, over: Partial<Tech> = {}): Tech {
  return {
    id,
    name: `tech ${id}`,
    preTechs: [],
    preTechsImplicit: [],
    unlockRecipes: [],
    unlockFunctions: [],
    level: 0,
    maxLevel: 0,
    isObsolete: false,
    isHidden: false,
    published: true,
    position: [0, 0],
    ...over,
  };
}

/** The fixture with its tech list replaced, for cases the 0.10.29 fixture cannot express. */
function withTechs(techs: Tech[]): GameData {
  return { ...data, techs };
}

describe('techClosure', () => {
  it('adds every preTech transitively, including the starting techs', () => {
    const closure = techClosure(data, [1302]);
    expect(closure.has(1302)).toBe(true);
    expect(closure.has(1311)).toBe(true);
    expect(closure.has(1001)).toBe(true);
    expect(closure.has(1)).toBe(true);
  });

  it('does not pull in techs the target does not depend on', () => {
    const closure = techClosure(data, [1302]);
    expect(closure.has(1303)).toBe(false);
  });

  it('follows preTechs but not preTechsImplicit', () => {
    const d = withTechs([tech(1), tech(2), tech(3, { preTechs: [1], preTechsImplicit: [2] })]);
    expect([...techClosure(d, [3])].sort()).toEqual([1, 3]);
  });

  it('is empty for no input and accepts any iterable', () => {
    expect(techClosure(data, []).size).toBe(0);
    expect(techClosure(data, new Set([1311])).has(1201)).toBe(true);
  });

  it('terminates on a prerequisite cycle', () => {
    const d = withTechs([tech(1, { preTechs: [2] }), tech(2, { preTechs: [1] })]);
    expect([...techClosure(d, [1])].sort()).toEqual([1, 2]);
  });

  it('throws naming an unknown tech id', () => {
    expect(() => techClosure(data, [999999])).toThrow(/999999/);
    const d = withTechs([tech(1, { preTechs: [77] })]);
    expect(() => techClosure(d, [1])).toThrow(/77/);
  });
});

describe('allTechs', () => {
  it('is every published, non-obsolete tech', () => {
    const all = allTechs(data);
    const expected = data.techs.filter((t) => t.published && !t.isObsolete).map((t) => t.id);
    expect(all.size).toBe(expected.length);
    expect(all.has(1302)).toBe(true);
    // 3301-3306 (sorter cargo stacking, pre-0.10.29) are obsolete.
    expect(all.has(3306)).toBe(false);
  });

  it('keeps hidden techs, drops unpublished and obsolete ones', () => {
    const d = withTechs([
      tech(1),
      tech(2, { isHidden: true }),
      tech(3, { published: false }),
      tech(4, { isObsolete: true }),
    ]);
    expect([...allTechs(d)].sort()).toEqual([1, 2]);
  });
});

describe('computeTechEffects: unlocked recipes and buildings', () => {
  it('unlocks the initial recipes (listed by no tech) with the empty set', () => {
    const fx = computeTechEffects(data, new Set());
    expect(fx.unlockedRecipes.has(1)).toBe(true);
    expect(fx.unlockedRecipes.has(51)).toBe(false);
  });

  it('unlocks 51 (Processor) but not 52 (Quantum Chip) for the closure of 1302', () => {
    const fx = computeTechEffects(data, techClosure(data, [1302]));
    expect(fx.unlockedRecipes.has(51)).toBe(true);
    expect(fx.unlockedRecipes.has(52)).toBe(false);
    expect(fx.unlockedRecipes.has(1)).toBe(true);
  });

  it('unlocks every recipe with all techs', () => {
    const fx = computeTechEffects(data, allTechs(data));
    expect(fx.unlockedRecipes.size).toBe(data.recipes.length);
  });

  it('makes a building available once some unlocked recipe outputs its item id', () => {
    const none = computeTechEffects(data, new Set());
    const all = computeTechEffects(data, allTechs(data));
    expect(none.availableBuildings.has(2305)).toBe(false);
    expect(all.availableBuildings.has(2305)).toBe(true);
  });

  it('lists only building item ids, not other recipe outputs', () => {
    const all = computeTechEffects(data, allTechs(data));
    const buildingIds = new Set(data.buildings.map((b) => b.itemId));
    expect(all.availableBuildings.size).toBeGreaterThan(0);
    for (const id of all.availableBuildings) expect(buildingIds.has(id)).toBe(true);
    expect(all.availableBuildings.has(1303)).toBe(false);
  });

  it('keeps a recipe locked when its only unlocking tech is obsolete', () => {
    const d: GameData = {
      ...data,
      techs: [tech(1, { isObsolete: true, unlockRecipes: [51] })],
    };
    const fx = computeTechEffects(d, new Set([1]));
    // Listed by an (ignored) obsolete tech, so not an initial recipe either.
    expect(fx.unlockedRecipes.has(51)).toBe(false);
    // Listed by no tech at all: initial.
    expect(fx.unlockedRecipes.has(1)).toBe(true);
  });
});

describe('computeTechEffects: logistics levels', () => {
  it('holds the base values with the empty set', () => {
    const fx = computeTechEffects(data, new Set());
    expect(fx.stationPilerLevel).toBe(1);
    expect(fx.inserterStackInput).toBe(2);
    expect(fx.inserterStackOutput).toBe(1);
    expect(fx.labLevel).toBe(3);
    expect(fx.storageLevel).toBe(2);
    expect(fx.beltVerticalConstruction).toBe(false);
    expect(fx.beltMaxLevel).toBe(12);
  });

  it('reaches the end-game values with all techs on the fixture', () => {
    const fx = computeTechEffects(data, allTechs(data));
    expect(fx.stationPilerLevel).toBe(4); // 1 + 3801..3803 (+1 each)
    expect(fx.inserterStackOutput).toBe(4); // max(3311: 2, 3313: 3, 3315: 4)
    expect(fx.inserterStackInput).toBe(4); // max(3312: 3, 3314: 4)
    expect(fx.storageLevel).toBe(8); // 2 + 6 * 1
    expect(fx.labLevel).toBe(15); // 3 + 6 * 2
    expect(fx.beltMaxLevel).toBe(48); // 12 + 6 * 6
    // 0.10.29 has no tech with unlock function 42.
    expect(fx.beltVerticalConstruction).toBe(false);
  });

  it('applies partial progress: additive sums, assign takes the max', () => {
    const fx = computeTechEffects(data, new Set([3801, 3802, 3311, 3313, 3701, 3702]));
    expect(fx.stationPilerLevel).toBe(3);
    expect(fx.inserterStackOutput).toBe(3);
    expect(fx.inserterStackInput).toBe(2);
    expect(fx.storageLevel).toBe(4);
    expect(fx.labLevel).toBe(7);
    expect(fx.beltMaxLevel).toBe(24);
  });

  it('ignores obsolete techs, so 3306 does not raise the output stack on its own', () => {
    const fx = computeTechEffects(data, new Set([3306]));
    expect(fx.inserterStackOutput).toBe(1);
  });

  it('ignores obsolete techs even when they are in the unlocked set', () => {
    const d = withTechs([
      tech(1, { isObsolete: true, unlockFunctions: [{ func: 29, value: 5 }, { func: 42, value: 1 }] }),
    ]);
    const fx = computeTechEffects(d, new Set([1]));
    expect(fx.stationPilerLevel).toBe(1);
    expect(fx.beltVerticalConstruction).toBe(false);
  });

  it('sets beltVerticalConstruction when an unlocked tech has function 42', () => {
    const d = withTechs([
      tech(1711, { unlockFunctions: [{ func: 42, value: 1 }] }),
      tech(5, { unlockFunctions: [{ func: 29, value: 1 }] }),
    ]);
    expect(computeTechEffects(d, new Set([1711])).beltVerticalConstruction).toBe(true);
    expect(computeTechEffects(d, new Set([5])).beltVerticalConstruction).toBe(false);
    expect(computeTechEffects(d, allTechs(d)).beltVerticalConstruction).toBe(true);
  });

  it('counts a leveled tech proto once, however many levels it spans', () => {
    const d = withTechs([
      tech(1, { level: 1, maxLevel: 6, unlockFunctions: [{ func: 29, value: 1 }] }),
    ]);
    expect(computeTechEffects(d, new Set([1])).stationPilerLevel).toBe(2);
  });

  it('converts function values with (int)(v + 0.5)', () => {
    const d = withTechs([
      tech(1, { unlockFunctions: [{ func: 29, value: 0.4 }] }),
      tech(2, { unlockFunctions: [{ func: 29, value: 0.6 }] }),
      tech(3, { unlockFunctions: [{ func: 39, value: 2.5 }] }),
    ]);
    expect(computeTechEffects(d, new Set([1])).stationPilerLevel).toBe(1);
    expect(computeTechEffects(d, new Set([2])).stationPilerLevel).toBe(2);
    expect(computeTechEffects(d, new Set([3])).inserterStackOutput).toBe(3);
  });

  it('is independent of unlock order for the assign-max functions', () => {
    const d = withTechs([
      tech(1, { unlockFunctions: [{ func: 41, value: 4 }] }),
      tech(2, { unlockFunctions: [{ func: 41, value: 3 }] }),
    ]);
    expect(computeTechEffects(d, new Set([1, 2])).inserterStackInput).toBe(4);
    expect(computeTechEffects(d, new Set([2, 1])).inserterStackInput).toBe(4);
  });

  it('never lowers a stack level below its base', () => {
    const d = withTechs([tech(1, { unlockFunctions: [{ func: 41, value: 1 }, { func: 39, value: 0 }] })]);
    const fx = computeTechEffects(d, new Set([1]));
    expect(fx.inserterStackInput).toBe(2);
    expect(fx.inserterStackOutput).toBe(1);
  });

  it('derives beltMaxLevel from GameData.constants and the unlocked techs 3701-3706', () => {
    const d: GameData = {
      ...data,
      constants: { ...data.constants, beltMaxLevelBase: 10, beltMaxLevelPerVerticalTech: 3 },
      techs: [tech(3701), tech(3702), tech(3706), tech(3707), tech(3700)],
    };
    // 3700 and 3707 are outside the vertical-construction range.
    expect(computeTechEffects(d, new Set([3700, 3701, 3706, 3707])).beltMaxLevel).toBe(16);
  });

  it('throws naming an unlocked tech id the data does not have', () => {
    expect(() => computeTechEffects(data, new Set([999999]))).toThrow(/999999/);
  });
});
