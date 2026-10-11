import { describe, expect, it } from 'vitest';
import { loadFixtureGameData } from '../../test/fixtures/fixtureGameData';
import { planProduction } from '../lib/calc';
import type { PlanRequest } from '../lib/calc';
import { allTechs, computeTechEffects, GameDataIndex, techClosure } from '../lib/data';
import { buildTree, treeLeaves } from './tree';
import type { TreeRow } from './tree';

const data = loadFixtureGameData();
const index = new GameDataIndex(data);
const everything = allTechs(data);
const allEffects = computeTechEffects(data, everything);

const PROCESSOR = 1303;
const CIRCUIT_BOARD = 1301;
const IRON_INGOT = 1101;
const COPPER_INGOT = 1104;
const CHEMICAL_PLANT = 2309;
const IRON_ORE = 1001;
const GRAPHENE = 1123;

const RAW = new Set(data.items.filter((i) => i.type === 'RESOURCE').map((i) => i.id));

function request(over: Partial<PlanRequest> = {}): PlanRequest {
  return {
    targetItemId: PROCESSOR,
    quantity: { kind: 'rate', perSecond: 1 },
    finalFacilityItemId: 2305,
    unlockedTechs: everything,
    suppliedItemIds: new Set(RAW),
    facilityOverrides: {},
    recipeOverrides: {},
    proliferator: { tier: 0, mode: 'extra' },
    stationKind: 'planetary',
    ...over,
  };
}

function rowFor(rows: TreeRow[], itemId: number): TreeRow {
  const row = rows.find((r) => r.itemId === itemId);
  if (!row) throw new Error(`no row for item ${itemId}`);
  return row;
}

describe('buildTree', () => {
  it('walks the recipe tree from the target down to the raw leaves', () => {
    const rows = buildTree(index, allEffects, request(), null);
    expect(rows[0]).toMatchObject({ itemId: PROCESSOR, depth: 0, root: true, supplied: false, repeat: false });
    expect(rows[0].recipe?.id).toBe(51);

    const circuit = rowFor(rows, CIRCUIT_BOARD);
    expect(circuit.depth).toBe(1);
    expect(circuit.recipe?.id).toBe(50);

    const ore = rowFor(rows, IRON_ORE);
    expect(ore).toMatchObject({ supplied: true, leaf: true, recipe: undefined, producers: [] });
  });

  it('lists the rows in depth-first order', () => {
    const rows = buildTree(index, allEffects, request(), null);
    const ids = rows.map((r) => r.itemId);
    // Circuit Board comes right before its own inputs.
    const at = ids.indexOf(CIRCUIT_BOARD);
    expect(rows[at + 1].depth).toBe(2);
    expect(rows[at + 1].itemId).toBe(IRON_INGOT);
  });

  it('expands an item once and marks later occurrences as repeats', () => {
    const rows = buildTree(index, allEffects, request(), null);
    // Circuit Board and Microcrystalline Component both take Copper Ingot.
    const ingots = rows.filter((r) => r.itemId === COPPER_INGOT);
    expect(ingots).toHaveLength(2);
    expect(ingots[0]).toMatchObject({ repeat: false, recipe: expect.objectContaining({ id: 3 }) });
    expect(ingots[1]).toMatchObject({ repeat: true, recipe: undefined });
  });

  it('does not expand a supplied item', () => {
    const supplied = new Set(RAW).add(IRON_INGOT);
    const rows = buildTree(index, allEffects, request({ suppliedItemIds: supplied }), null);
    expect(rowFor(rows, IRON_INGOT)).toMatchObject({ supplied: true, leaf: false, recipe: undefined });
    expect(rows.some((r) => r.itemId === IRON_ORE)).toBe(false);
  });

  it('never marks the target as supplied or leaves it unexpanded', () => {
    const supplied = new Set(RAW).add(PROCESSOR);
    const rows = buildTree(index, allEffects, request({ suppliedItemIds: supplied }), null);
    expect(rows[0].supplied).toBe(false);
    expect(rows.length).toBeGreaterThan(1);
  });

  it('uses the recipe override for an item', () => {
    const none = buildTree(index, allEffects, request({ targetItemId: GRAPHENE }), null);
    expect(none[0].recipe?.id).toBe(31);
    expect(none[0].producers.map((r) => r.id)).toEqual([31, 32]);

    const forced = buildTree(
      index,
      allEffects,
      request({ targetItemId: GRAPHENE, recipeOverrides: { [GRAPHENE]: 32 } }),
      null,
    );
    expect(forced[0].recipe?.id).toBe(32);
  });

  it('follows the recipe the plan chose when nothing overrides it', async () => {
    const req = request({ targetItemId: GRAPHENE, finalFacilityItemId: CHEMICAL_PLANT });
    const plan = await planProduction(req, index, allEffects);
    expect(plan.ok).toBe(true);
    const stageRecipe = plan.ok ? plan.plan.stages[0].recipeId : -1;
    const rows = buildTree(index, allEffects, req, plan);
    expect(rows[0].recipe?.id).toBe(stageRecipe);
  });

  it('shows items nothing unlocked makes as leaves, supplied or not', () => {
    const small = computeTechEffects(data, techClosure(data, [1302]));
    const unsupplied = buildTree(index, small, request({ unlockedTechs: new Set(), suppliedItemIds: new Set() }), null);
    expect(rowFor(unsupplied, 1105)).toMatchObject({ leaf: true, supplied: false });
  });

  it('survives recipe loops', () => {
    // X-ray Cracking makes Hydrogen from Hydrogen and Refined Oil, and Plasma Refining makes both.
    const rows = buildTree(index, allEffects, request({ targetItemId: 1120, recipeOverrides: { 1120: 58 } }), null);
    expect(rows.length).toBeLessThan(20);
    expect(rows.some((r) => r.repeat)).toBe(true);
  });

  it('returns no rows without a target', () => {
    expect(buildTree(index, allEffects, request({ targetItemId: 0 }), null)).toEqual([]);
  });
});

describe('treeLeaves', () => {
  it('lists the leaves reachable through items that are not supplied', () => {
    const noSupply = request({ suppliedItemIds: new Set() });
    const leaves = treeLeaves(index, allEffects, noSupply);
    expect(leaves).toContain(IRON_ORE);
    expect(leaves).toContain(1002);
    expect(leaves.every((id) => index.recipesProducing(id).length === 0)).toBe(true);
  });

  it('stops at supplied items', () => {
    const leaves = treeLeaves(index, allEffects, request({ suppliedItemIds: new Set([IRON_INGOT, 1104, 1105, 1102]) }));
    expect(leaves).not.toContain(IRON_ORE);
  });
});
