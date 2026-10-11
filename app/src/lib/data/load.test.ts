import { describe, expect, it } from 'vitest';
import { minimalGameData } from '../../../test/fixtures/minimalGameData';
import { compareGameVersions, GameDataError, GameDataIndex, parseGameData } from './load';
import type { GameData, Recipe } from './schema';

describe('parseGameData', () => {
  it('returns the parsed GameData for valid input', () => {
    const data = parseGameData(minimalGameData(), 'dsp-0.10.35.json');
    expect(data.items[0].id).toBe(1101);
  });

  it('throws a GameDataError naming the file and the zod issue path', () => {
    const bad = minimalGameData() as unknown as { recipes: Record<string, unknown>[] };
    delete bad.recipes[0].timeTicks;
    let thrown: unknown;
    try {
      parseGameData(bad, 'dsp-0.10.35.json');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GameDataError);
    const message = (thrown as GameDataError).message;
    expect(message).toContain('dsp-0.10.35.json');
    expect(message).toContain('recipes.0.timeTicks');
  });

  it('rejects an unknown schemaVersion, naming the file and the version', () => {
    const bad = minimalGameData() as unknown as { meta: Record<string, unknown> };
    bad.meta.schemaVersion = 2;
    expect(() => parseGameData(bad, 'dsp-0.99.0.json')).toThrow(/dsp-0\.99\.0\.json.*schemaVersion.*2/s);
  });

  it('rejects input that is not an object', () => {
    expect(() => parseGameData(null, 'dsp-x.json')).toThrow(/dsp-x\.json/);
    expect(() => parseGameData('nope', 'dsp-x.json')).toThrow(GameDataError);
  });
});

function twoGrapheneRecipes(): GameData {
  const data = minimalGameData();
  const graphene = (id: number, name: string, inputItem: number): Recipe => ({
    id,
    name,
    type: 'CHEMICAL',
    timeTicks: 120,
    inputs: [{ itemId: inputItem, count: 2 }],
    outputs: [
      { itemId: 1123, count: 2 },
      { itemId: 1120, count: 1 },
    ],
    explicit: true,
    nonProductive: false,
    handcraft: false,
    gridIndex: 1,
  });
  data.recipes.push(graphene(16, 'Graphene', 1011), graphene(123, 'Graphene (advanced)', 1109));
  return data;
}

describe('GameDataIndex', () => {
  it('recipesProducing returns every recipe with the item among its outputs', () => {
    const index = new GameDataIndex(twoGrapheneRecipes());
    expect(index.recipesProducing(1123).map((r) => r.id)).toEqual([16, 123]);
    expect(index.recipesProducing(1101).map((r) => r.id)).toEqual([1]);
  });

  it('recipesProducing returns an empty list for an item nothing produces', () => {
    expect(new GameDataIndex(minimalGameData()).recipesProducing(4242)).toEqual([]);
  });

  it('looks up items, recipes and buildings by id', () => {
    const index = new GameDataIndex(twoGrapheneRecipes());
    expect(index.item(1101).name).toBe('Iron Ingot');
    expect(index.recipe(16).name).toBe('Graphene');
    expect(index.building(2302)?.name).toBe('Arc Smelter');
    expect(index.building(999)).toBeUndefined();
  });

  it('throws, naming the id, on an unknown item or recipe', () => {
    const index = new GameDataIndex(minimalGameData());
    expect(() => index.item(999)).toThrow(/item 999/);
    expect(() => index.recipe(999)).toThrow(/recipe 999/);
  });

  it('buildingsForRecipeType returns production buildings by recipe type', () => {
    const index = new GameDataIndex(minimalGameData());
    expect(index.buildingsForRecipeType('SMELT').map((b) => b.itemId)).toEqual([2302]);
    expect(index.buildingsForRecipeType('ASSEMBLE')).toEqual([]);
  });

  it('exposes the underlying GameData', () => {
    const data = minimalGameData();
    expect(new GameDataIndex(data).data).toBe(data);
  });
});

describe('compareGameVersions', () => {
  it('orders dotted versions numerically, not lexically', () => {
    expect(compareGameVersions('0.10.35.1', '0.9.27.0')).toBeGreaterThan(0);
    expect(compareGameVersions('0.9.27', '0.10.0')).toBeLessThan(0);
    expect(compareGameVersions('0.10.35', '0.10.35.0')).toBe(0);
  });

  it('orders the 0.0.0+build<id> fallback form by build id', () => {
    expect(compareGameVersions('0.0.0+build200', '0.0.0+build1000')).toBeLessThan(0);
    expect(compareGameVersions('0.0.0+build5', '0.10.0')).toBeLessThan(0);
  });
});
