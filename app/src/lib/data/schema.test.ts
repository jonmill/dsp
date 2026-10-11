import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { minimalGameData } from '../../../test/fixtures/minimalGameData';
import { gameDataJsonSchema, GameDataSchema } from './schema';
import type { Constants, GameData, Quat, Vec3 } from './schema';

describe('GameDataSchema', () => {
  it('accepts a minimal valid GameData literal', () => {
    const result = GameDataSchema.safeParse(minimalGameData());
    expect(result.success).toBe(true);
  });

  it('rejects an unknown schemaVersion', () => {
    const bad = { ...minimalGameData(), meta: { ...minimalGameData().meta, schemaVersion: 2 } };
    const result = GameDataSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('meta.schemaVersion');
    }
  });

  it('rejects a recipe missing timeTicks and reports its path', () => {
    const bad = minimalGameData() as unknown as { recipes: Record<string, unknown>[] };
    delete bad.recipes[0].timeTicks;
    const result = GameDataSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('recipes.0.timeTicks');
    }
  });

  it('rejects unknown keys (strict objects)', () => {
    const bad = minimalGameData() as unknown as { items: Record<string, unknown>[] };
    bad.items[0].surprise = true;
    expect(GameDataSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-integer id', () => {
    const bad = minimalGameData();
    bad.items[0].id = 1.5;
    expect(GameDataSchema.safeParse(bad).success).toBe(false);
  });

  it('requires a constantSources entry for every Constants key', () => {
    const bad = minimalGameData() as unknown as { constantSources: Record<string, unknown> };
    delete bad.constantSources.tileMeters;
    const result = GameDataSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('constantSources.tileMeters');
    }
  });

  it('has the documented inferred types', () => {
    // Compile-time only (checked by `npm run check`).
    expectTypeOf<Vec3>().toEqualTypeOf<[number, number, number]>();
    expectTypeOf<Quat>().toEqualTypeOf<[number, number, number, number]>();
    expectTypeOf<GameData['meta']['schemaVersion']>().toEqualTypeOf<1>();
    expectTypeOf<GameData['constantSources']>().toEqualTypeOf<Record<keyof Constants, string>>();
  });
});

describe('gamedata.schema.json', () => {
  it('is up to date with GameDataSchema (run `npm run schema` after changing it)', () => {
    const committed: unknown = JSON.parse(
      readFileSync(new URL('../../../../data/schema/gamedata.schema.json', import.meta.url), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(gameDataJsonSchema())));
  });

  it('targets Draft 2020-12', () => {
    expect(gameDataJsonSchema().$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });
});
