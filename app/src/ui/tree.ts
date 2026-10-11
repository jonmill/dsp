/**
 * The recipe tree shown in the Inputs panel: the target at the top, each item's inputs below it.
 * It is walked from the recipes, not from the plan's stages, so it still shows when the plan fails
 * (a missing input is exactly when the user needs to see and toggle it). Where the plan did pick a
 * recipe the tree follows it, so the tree and the plan table agree.
 */
import { plannableProducers } from '../lib/calc';
import type { PlanRequest, PlanResult } from '../lib/calc';
import type { GameDataIndex, Recipe, TechEffects } from '../lib/data';

export interface TreeRow {
  itemId: number;
  depth: number;
  /** The target; it is always made, never supplied. */
  root: boolean;
  /** Unlocked, plannable recipes that make the item (empty for a leaf). */
  producers: Recipe[];
  /** In the supplied set (never true for the root). */
  supplied: boolean;
  /** No unlocked recipe makes it, so it can only be supplied. */
  leaf: boolean;
  /** Already expanded higher up the tree; its inputs are not repeated. */
  repeat: boolean;
  /** The recipe whose inputs follow this row; undefined for supplied items, leaves and repeats. */
  recipe: Recipe | undefined;
}

/** Override, else the recipe the plan used, else the first non-alternate, else the first. */
function chooseRecipe(producers: Recipe[], forced: number | undefined, planned: number[]): Recipe {
  const byId = (id: number) => producers.find((r) => r.id === id);
  if (forced !== undefined) {
    const recipe = byId(forced);
    if (recipe) return recipe;
  }
  for (const id of planned) {
    const recipe = byId(id);
    if (recipe) return recipe;
  }
  return producers.find((r) => !r.explicit) ?? producers[0];
}

export function buildTree(
  index: GameDataIndex,
  effects: TechEffects,
  request: PlanRequest,
  plan: PlanResult | null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  if (request.targetItemId === 0) return rows;
  const planned = plan?.ok ? plan.plan.stages.map((s) => s.recipeId) : [];
  const expanded = new Set<number>();

  const walk = (itemId: number, depth: number): void => {
    const producers = plannableProducers(itemId, index, effects);
    const root = depth === 0;
    const row: TreeRow = {
      itemId,
      depth,
      root,
      producers,
      supplied: !root && request.suppliedItemIds.has(itemId),
      leaf: producers.length === 0,
      repeat: expanded.has(itemId),
      recipe: undefined,
    };
    rows.push(row);
    if (row.repeat || row.supplied || row.leaf) return;

    expanded.add(itemId);
    row.recipe = chooseRecipe(producers, request.recipeOverrides[itemId], planned);
    for (const input of row.recipe.inputs) walk(input.itemId, depth + 1);
  };
  walk(request.targetItemId, 0);
  return rows;
}

/** Items under the target that nothing unlocked makes, reached without passing a supplied item. */
export function treeLeaves(index: GameDataIndex, effects: TechEffects, request: PlanRequest): number[] {
  const leaves = new Set<number>();
  for (const row of buildTree(index, effects, request, null)) if (row.leaf && !row.root) leaves.add(row.itemId);
  return [...leaves];
}
