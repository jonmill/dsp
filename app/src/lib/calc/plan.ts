/**
 * Production planner: turns a `PlanRequest` into a `ProductionPlan` with a linear program over
 * recipe rates. See `docs/research/datasets.md` ("Test targets") for the numbers it reproduces.
 *
 * Pipeline: candidate recipes (walk back from the target, drop what cannot be fed) -> facility per
 * recipe -> proliferator multipliers per recipe -> LP (fewest machine-seconds, then fewest imports,
 * then fewest exports) -> stages, flows, imports/exports, station slots, power.
 */
import type { Building, GameDataIndex, Recipe, RecipeType, TechEffects } from '../data';
import { solveLP } from './lp';
import type { LPConstraint, LPVariable } from './lp';
import { estimatePower } from './power';
import { canUseExtra, effectFor, proliferatorItemId, spraysPerItem } from './proliferator';
import type { ProliferatorEffect } from './proliferator';
import type {
  Flow,
  ItemRate,
  PlanError,
  PlanRequest,
  PlanResult,
  ProductionPlan,
  Stage,
  StationSlotDemand,
} from './types';

/** Rates and counts below this are solver noise. */
const EPS = 1e-9;

/** LP values are rounded to 1e-12 so 7.999999999999996 machines read as 8. */
function clean(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

/** Objective weights: machine-seconds dominate imports, which dominate exports. */
const COST_MACHINE = 1e6;
const COST_IMPORT = 1e3;
const COST_EXPORT = 1;

/** Recipes of these types are never part of a plan (fractionators, exchangers and the like). */
const EXCLUDED_TYPES: ReadonlySet<RecipeType> = new Set(['FRACTIONATE', 'EXCHANGE', 'PHOTON_STORE', 'NONE']);

const FIRST_MATRIX_ITEM = 6001;
const LAST_MATRIX_ITEM = 6006;

/** A typed failure, thrown while planning and turned into `{ ok: false }` at the entry point. */
class PlanFailure extends Error {
  constructor(readonly error: PlanError) {
    super(error.message);
  }
}

/** Matrix recipes are typed RESEARCH in the dump but are produced in labs. */
function isMatrixRecipe(recipe: Recipe): boolean {
  return recipe.outputs.some((o) => o.itemId >= FIRST_MATRIX_ITEM && o.itemId <= LAST_MATRIX_ITEM);
}

/** Can the building run this recipe? Matrix recipes need a lab; everything else matches `recipeType`. */
function facilityCompatible(building: Building, recipe: Recipe): boolean {
  if (isMatrixRecipe(recipe)) return building.kind === 'lab' && building.lab !== undefined;
  return building.production !== undefined && building.production.recipeType === recipe.type;
}

/** Speed multiplier of a facility (1.0 = 10000). */
function facilitySpeed(building: Building): number {
  const raw = building.kind === 'lab' ? building.lab?.assembleSpeed : building.production?.speed;
  if (raw === undefined) throw new Error(`building ${building.itemId} (${building.name}) has no speed`);
  return raw / 10000;
}

/** Recipes of these types are plannable; everything else (fractionation, exchange, ...) is not. */
export function isPlannableRecipe(recipe: Recipe): boolean {
  return !EXCLUDED_TYPES.has(recipe.type) && (recipe.type !== 'RESEARCH' || isMatrixRecipe(recipe));
}

/** Unlocked, plannable recipes that make `itemId`, in GameData order (overrides not applied). */
export function plannableProducers(itemId: number, data: GameDataIndex, effects: TechEffects): Recipe[] {
  return data.recipesProducing(itemId).filter((r) => effects.unlockedRecipes.has(r.id) && isPlannableRecipe(r));
}

/** Every building that can run `recipe` (matrix recipes: labs), slowest first, which is unlock order. */
export function compatibleFacilities(recipe: Recipe, data: GameDataIndex): Building[] {
  const pool = isMatrixRecipe(recipe)
    ? data.data.buildings.filter((b) => b.kind === 'lab')
    : data.buildingsForRecipeType(recipe.type);
  return pool.filter((b) => facilityCompatible(b, recipe)).sort((a, b) => facilitySpeed(a) - facilitySpeed(b));
}

function fastest(buildings: Building[]): Building | undefined {
  let best: Building | undefined;
  for (const b of buildings) if (!best || facilitySpeed(b) > facilitySpeed(best)) best = b;
  return best;
}

/** The first building to unlock: the slowest one, which comes earliest in the tech tree. */
function slowest(buildings: Building[]): Building | undefined {
  let best: Building | undefined;
  for (const b of buildings) if (!best || facilitySpeed(b) < facilitySpeed(best)) best = b;
  return best;
}

/** One candidate recipe with the facility and proliferator it would run with. */
interface Node {
  recipe: Recipe;
  building: Building;
  effect: ProliferatorEffect;
  /** Building speed times the proliferator speed-up. */
  effectiveSpeed: number;
  /** Machine-seconds one craft costs. */
  secondsPerCraft: number;
}

class Planner {
  private readonly supplied: Set<number>;
  private readonly facilityCache = new Map<number, Building[]>();

  constructor(
    private readonly req: PlanRequest,
    private readonly data: GameDataIndex,
    private readonly effects: TechEffects,
  ) {
    this.supplied = new Set(req.suppliedItemIds);
    // The target is always built, never taken from the supply.
    this.supplied.delete(req.targetItemId);
  }

  // -- names and messages ------------------------------------------------------------------

  private itemName(itemId: number): string {
    try {
      return this.data.item(itemId).name;
    } catch {
      return `item ${itemId}`;
    }
  }

  private buildingName(itemId: number): string {
    return this.data.building(itemId)?.name ?? `building ${itemId}`;
  }

  /** " Research A or B to unlock it." for the locked techs that unlock one of `recipeIds`. */
  private techHint(recipeIds: number[]): string {
    const wanted = new Set(recipeIds);
    const names = this.data.data.techs
      .filter((t) => !t.isObsolete && !this.req.unlockedTechs.has(t.id) && t.unlockRecipes.some((id) => wanted.has(id)))
      .map((t) => t.name);
    return names.length > 0 ? ` Research ${names.slice(0, 3).join(' or ')} to unlock it.` : '';
  }

  // -- candidate recipes -------------------------------------------------------------------

  /** Unlocked recipes of a plannable type that make `itemId`, honouring `recipeOverrides`. */
  private rawProducers(itemId: number): Recipe[] {
    const forced = this.req.recipeOverrides[itemId];
    return plannableProducers(itemId, this.data, this.effects).filter((r) => forced === undefined || r.id === forced);
  }

  /** Unlocked buildings that can run `recipe`. */
  private availableFacilities(recipe: Recipe): Building[] {
    let list = this.facilityCache.get(recipe.id);
    if (!list) {
      list = compatibleFacilities(recipe, this.data).filter((b) => this.effects.availableBuildings.has(b.itemId));
      this.facilityCache.set(recipe.id, list);
    }
    return list;
  }

  /** A recipe is usable if some unlocked building can run it; an override is checked later. */
  private hasFacility(recipe: Recipe): boolean {
    return this.req.facilityOverrides[recipe.id] !== undefined || this.availableFacilities(recipe).length > 0;
  }

  private usableProducers(itemId: number): Recipe[] {
    return this.rawProducers(itemId).filter((r) => this.hasFacility(r));
  }

  /** Breadth-first from the target over `producers`, stopping at supplied items. */
  private collect(producers: (itemId: number) => Recipe[]): Map<number, Recipe> {
    const found = new Map<number, Recipe>();
    const seen = new Set<number>([this.req.targetItemId]);
    const queue = [this.req.targetItemId];
    for (let i = 0; i < queue.length; i++) {
      const itemId = queue[i];
      if (this.supplied.has(itemId)) continue;
      for (const recipe of producers(itemId)) {
        if (found.has(recipe.id)) continue;
        found.set(recipe.id, recipe);
        for (const input of recipe.inputs) {
          if (seen.has(input.itemId)) continue;
          seen.add(input.itemId);
          queue.push(input.itemId);
        }
      }
    }
    return found;
  }

  /**
   * The recipes the LP may use. Alternates that cannot be fed are dropped (Graphene 32 without Fire
   * Ice, Hydrogen 74 without Critical Photon): a recipe survives only if every input is supplied or
   * made by a surviving recipe, which also rejects loops with no outside source.
   */
  private candidateRecipes(): Recipe[] {
    const target = this.req.targetItemId;
    const targetRecipes = this.rawProducers(target);
    if (targetRecipes.length === 0) {
      if (this.req.suppliedItemIds.has(target)) {
        throw new PlanFailure({
          kind: 'infeasible',
          message: `${this.itemName(target)} is supplied and has no recipe, so there is nothing to plan.`,
        });
      }
      const forced = this.req.recipeOverrides[target];
      const locked = this.data
        .recipesProducing(target)
        .filter((r) => forced === undefined || r.id === forced)
        .map((r) => r.id);
      const why = forced === undefined ? 'no unlocked recipe makes it' : `its recipe override (${forced}) is not unlocked or not usable`;
      throw new PlanFailure({
        kind: 'target-locked',
        itemId: target,
        message: `${this.itemName(target)} cannot be built: ${why}.${this.techHint(locked)}`,
      });
    }
    if (this.usableProducers(target).length === 0) {
      const recipe = targetRecipes[0];
      const needed = slowest(compatibleFacilities(recipe, this.data));
      throw new PlanFailure({
        kind: 'facility-unavailable',
        recipeId: recipe.id,
        buildingItemId: needed?.itemId ?? 0,
        message: `${this.itemName(target)} (recipe ${recipe.name}) needs ${needed?.name ?? 'a facility'}, which is not unlocked yet.`,
      });
    }

    const reachable = this.collect((itemId) => this.usableProducers(itemId));
    const producible = new Set(this.supplied);
    const enabled = new Set<number>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const recipe of reachable.values()) {
        if (enabled.has(recipe.id) || !recipe.inputs.every((i) => producible.has(i.itemId))) continue;
        enabled.add(recipe.id);
        for (const o of recipe.outputs) producible.add(o.itemId);
        changed = true;
      }
    }
    if (!producible.has(target)) throw this.noRecipe(producible);

    const needed = this.collect((itemId) => this.usableProducers(itemId).filter((r) => enabled.has(r.id)));
    return [...needed.values()].sort((a, b) => a.id - b.id);
  }

  /** The first item, walking from the target, that is neither supplied nor makeable. */
  private noRecipe(producible: Set<number>): PlanFailure {
    const visited = new Set<number>();
    const find = (itemId: number): number | undefined => {
      if (producible.has(itemId) || visited.has(itemId)) return undefined;
      visited.add(itemId);
      const producers = this.usableProducers(itemId);
      if (producers.length === 0) return itemId;
      for (const recipe of producers) {
        for (const input of recipe.inputs) {
          const blocker = find(input.itemId);
          if (blocker !== undefined) return blocker;
        }
      }
      return undefined;
    };
    const blocker = find(this.req.targetItemId);
    if (blocker === undefined) {
      return new PlanFailure({
        kind: 'infeasible',
        message: `${this.itemName(this.req.targetItemId)} only appears in recipe loops that nothing outside feeds.`,
      });
    }
    const unlockedRecipes = this.rawProducers(blocker);
    if (unlockedRecipes.length > 0) {
      // A recipe exists, but no unlocked building can run it.
      const recipe = unlockedRecipes[0];
      const needed = slowest(compatibleFacilities(recipe, this.data));
      return new PlanFailure({
        kind: 'facility-unavailable',
        recipeId: recipe.id,
        buildingItemId: needed?.itemId ?? 0,
        message:
          `Cannot build ${this.itemName(this.req.targetItemId)}: ${this.itemName(blocker)} (recipe ${recipe.name}) ` +
          `needs ${needed?.name ?? 'a facility'}, which is not unlocked yet.`,
      });
    }
    const forced = this.req.recipeOverrides[blocker];
    const why =
      forced === undefined
        ? 'it is not supplied and no unlocked recipe makes it'
        : `it is not supplied and its recipe override (${forced}) is locked or does not make it`;
    const hint = this.techHint(
      this.data
        .recipesProducing(blocker)
        .filter((r) => forced === undefined || r.id === forced)
        .map((r) => r.id),
    );
    return new PlanFailure({
      kind: 'no-recipe',
      itemId: blocker,
      message: `Cannot build ${this.itemName(this.req.targetItemId)}: ${this.itemName(blocker)} is required but ${why}.${hint}`,
    });
  }

  // -- facilities --------------------------------------------------------------------------

  private checkOverride(recipe: Recipe, buildingItemId: number): Building {
    const building = this.data.building(buildingItemId);
    const fail = (message: string) =>
      new PlanFailure({ kind: 'facility-unavailable', recipeId: recipe.id, buildingItemId, message });
    if (!building) throw fail(`Facility override for ${recipe.name} (${buildingItemId}) is not a building.`);
    if (!facilityCompatible(building, recipe)) {
      const needs = isMatrixRecipe(recipe) ? 'a lab' : `a building for ${recipe.type} recipes`;
      throw fail(`${building.name} cannot run ${recipe.name}, which needs ${needs}.`);
    }
    if (!this.effects.availableBuildings.has(buildingItemId)) {
      throw fail(`${building.name} is not unlocked yet, so it cannot run ${recipe.name}.`);
    }
    return building;
  }

  /** Override, else the final facility (target recipes only), else the fastest unlocked building. */
  private facilities(candidates: Recipe[]): Map<number, Building> {
    const target = this.req.targetItemId;
    const finalId = this.req.finalFacilityItemId;
    const finalBuilding = this.data.building(finalId);
    const finalUsable = (recipe: Recipe): boolean =>
      finalBuilding !== undefined &&
      this.effects.availableBuildings.has(finalId) &&
      facilityCompatible(finalBuilding, recipe);
    const makesTarget = (recipe: Recipe) => recipe.outputs.some((o) => o.itemId === target);

    // The final facility must fit at least one target recipe that is not pinned by an override.
    const unpinned = candidates.filter((r) => makesTarget(r) && this.req.facilityOverrides[r.id] === undefined);
    if (unpinned.length > 0 && !unpinned.some(finalUsable)) {
      const recipe = unpinned[0];
      const why = !finalBuilding
        ? `${finalId} is not a building`
        : !this.effects.availableBuildings.has(finalId)
          ? `${finalBuilding.name} is not unlocked yet`
          : `${finalBuilding.name} cannot run ${recipe.name}`;
      throw new PlanFailure({
        kind: 'facility-unavailable',
        recipeId: recipe.id,
        buildingItemId: finalId,
        message: `Final facility ${this.buildingName(finalId)} is unusable for ${this.itemName(target)}: ${why}.`,
      });
    }

    const chosen = new Map<number, Building>();
    for (const recipe of candidates) {
      const forced = this.req.facilityOverrides[recipe.id];
      let building: Building | undefined;
      if (forced !== undefined) building = this.checkOverride(recipe, forced);
      else if (makesTarget(recipe) && finalUsable(recipe)) building = finalBuilding;
      else building = fastest(this.availableFacilities(recipe));
      if (!building) throw new Error(`no facility for recipe ${recipe.id}`); // excluded by hasFacility
      chosen.set(recipe.id, building);
    }
    return chosen;
  }

  // -- plan --------------------------------------------------------------------------------

  async plan(): Promise<ProductionPlan> {
    const { req, data, effects } = this;
    this.validate();
    const candidates = this.candidateRecipes();
    const { nodes, required, pin } = this.nodesAndTargetRate(candidates, this.facilities(candidates));
    const solution = await this.solve(nodes, required, pin);

    const crafts = new Map<number, number>();
    for (const n of nodes) {
      const x = clean(solution.values[`x${n.recipe.id}`] ?? 0);
      if (x > EPS) crafts.set(n.recipe.id, x);
    }
    const stageNodes = this.stageOrder(nodes.filter((n) => crafts.has(n.recipe.id)));
    if (stageNodes.length === 0) {
      // The solver accepts any rate within its tolerance of zero, so a tiny request solves to nothing.
      throw new PlanFailure({
        kind: 'infeasible',
        message: `The requested quantity of ${this.itemName(req.targetItemId)} (${required} per second) is too small to plan.`,
      });
    }
    const stages = stageNodes.map((n) => this.stageOf(n, crafts.get(n.recipe.id) as number));

    const { importRate, exportRate } = this.balance(nodes, solution.values, required);
    const materials = [...importRate].map(([itemId, perSecond]) => ({ itemId, perSecond }));
    // The target is exported first, then the by-products nothing consumes.
    const exports = [
      { itemId: req.targetItemId, perSecond: exportRate.get(req.targetItemId) ?? required },
      ...[...exportRate].filter(([itemId]) => itemId !== req.targetItemId).map(([itemId, perSecond]) => ({ itemId, perSecond })),
    ];

    // The proliferator is one more import. It feeds the spray coaters, not a stage, so it has no flows.
    const { proliferatorPerSecond, warnings } = this.proliferation(stages);
    if (req.suppliedItemIds.has(req.targetItemId)) {
      warnings.push(`${this.itemName(req.targetItemId)} is marked supplied but is the target; it will be produced.`);
    }
    const imports = materials.map((m) => ({ ...m }));
    let sprayItemId: number | undefined;
    if (proliferatorPerSecond > 0) {
      sprayItemId = proliferatorItemId(req.proliferator.tier as 1 | 2 | 3);
      const existing = imports.find((i) => i.itemId === sprayItemId);
      if (existing) existing.perSecond += proliferatorPerSecond;
      else imports.push({ itemId: sprayItemId, perSecond: proliferatorPerSecond });
    }
    const stationSlots = this.stationSlots(
      materials.map((m) => m.itemId),
      sprayItemId,
      exports.map((e) => e.itemId),
    );

    const withoutPower = {
      request: req,
      stages,
      flows: this.flows(stages, importRate, exportRate),
      imports,
      exports,
      actualTargetRate: Math.max(required, this.targetCapacity(stageNodes, stages)),
      stationSlots,
      stationsNeeded: this.stationsNeeded(stationSlots.length),
      proliferatorPerSecond,
      warnings,
    };
    return { ...withoutPower, power: estimatePower(withoutPower, data, effects) };
  }

  /**
   * One node per candidate recipe and the target rate R. Buildings mode needs one definite recipe
   * for the target: the one `recipeOverrides` names, else the non-alternate, else the first. R is what
   * `count` machines of it make, and the LP pins that recipe at exactly `count` machines (`pin`), so a
   * by-product producer of the target (Hydrogen from Plasma Refining) cannot stand in for it.
   */
  private nodesAndTargetRate(
    candidates: Recipe[],
    buildings: Map<number, Building>,
  ): { nodes: Node[]; required: number; pin?: { recipeId: number; crafts: number } } {
    const { req, data } = this;
    const target = req.targetItemId;
    const ticksPerSecond = data.data.constants.ticksPerSecond;
    const nodes = candidates.map((recipe): Node => {
      const building = buildings.get(recipe.id) as Building;
      const effect = effectFor(req.proliferator.tier, req.proliferator.mode, recipe, data);
      const effectiveSpeed = facilitySpeed(building) * effect.speedMultiplier;
      return { recipe, building, effect, effectiveSpeed, secondsPerCraft: recipe.timeTicks / ticksPerSecond / effectiveSpeed };
    });

    if (req.quantity.kind === 'rate') return { nodes, required: req.quantity.perSecond };
    const producers = nodes.filter((n) => n.recipe.outputs.some((o) => o.itemId === target));
    const forced = req.recipeOverrides[target];
    const final =
      producers.find((n) => n.recipe.id === forced) ?? producers.find((n) => !n.recipe.explicit) ?? producers[0];
    const perCraft = final.recipe.outputs.find((o) => o.itemId === target)?.count ?? 0;
    const crafts = req.quantity.count / final.secondsPerCraft;
    return {
      nodes,
      required: crafts * perCraft * final.effect.outputMultiplier,
      pin: { recipeId: final.recipe.id, crafts },
    };
  }

  /** Cleaned import and export rates by item id (ascending). The target's export includes `required`. */
  private balance(nodes: Node[], values: Record<string, number>, required: number) {
    const itemIds = new Set<number>([this.req.targetItemId]);
    for (const n of nodes) {
      for (const i of n.recipe.inputs) itemIds.add(i.itemId);
      for (const o of n.recipe.outputs) itemIds.add(o.itemId);
    }
    const importRate = new Map<number, number>();
    const exportRate = new Map<number, number>();
    for (const itemId of [...itemIds].sort((a, b) => a - b)) {
      const imp = clean(values[`i${itemId}`] ?? 0);
      if (imp > EPS) importRate.set(itemId, imp);
      const exp = clean(values[`e${itemId}`] ?? 0) + (itemId === this.req.targetItemId ? required : 0);
      if (exp > EPS) exportRate.set(itemId, exp);
    }
    return { importRate, exportRate };
  }

  /**
   * Unsprayed proliferator the stations must import: every input item of a proliferated stage takes
   * one spray, and a Mk.III item carries 60. Also warns for each `extra` stage that fell back to speed.
   */
  private proliferation(stages: Stage[]): { proliferatorPerSecond: number; warnings: string[] } {
    const { tier, mode } = this.req.proliferator;
    const warnings: string[] = [];
    if (tier === 0) return { proliferatorPerSecond: 0, warnings };
    let sprayedItemsPerSecond = 0;
    for (const stage of stages) {
      if (!stage.proliferated) continue;
      for (const input of stage.inputs) sprayedItemsPerSecond += input.perSecond;
      const recipe = this.data.recipe(stage.recipeId);
      if (mode === 'extra' && !canUseExtra(recipe, this.data)) {
        warnings.push(
          `Proliferator extra products do not apply to ${recipe.name} (a non-productive recipe or input); using speed-up instead.`,
        );
      }
    }
    const perSecond = sprayedItemsPerSecond / spraysPerItem(tier, this.data);
    return { proliferatorPerSecond: perSecond > EPS ? perSecond : 0, warnings };
  }

  /**
   * What the rounded-up machines can deliver of the target (the ceil effect), net of the target the
   * stages eat themselves.
   */
  private targetCapacity(stageNodes: Node[], stages: Stage[]): number {
    const target = this.req.targetItemId;
    let capacity = 0;
    stageNodes.forEach((n, i) => {
      const s = stages[i];
      const perCraft = n.recipe.outputs.find((o) => o.itemId === target)?.count ?? 0;
      capacity += s.machines * s.perMachineCraftsPerSecond * perCraft * n.effect.outputMultiplier;
      capacity -= s.inputs.find((x) => x.itemId === target)?.perSecond ?? 0;
    });
    return capacity;
  }

  /**
   * One slot per item id, in the order imports, spray supply, exports. An item that needs several
   * (the target is also the spray item, or a regular import is also sprayed) keeps the most specific
   * role: export over proliferator over import.
   */
  private stationSlots(importIds: number[], sprayItemId: number | undefined, exportIds: number[]): StationSlotDemand[] {
    const rank: Record<StationSlotDemand['role'], number> = { import: 1, proliferator: 2, export: 3 };
    const roles = new Map<number, StationSlotDemand['role']>();
    const claim = (itemId: number, role: StationSlotDemand['role']) => {
      const current = roles.get(itemId);
      if (current === undefined || rank[role] > rank[current]) roles.set(itemId, role);
    };
    for (const itemId of importIds) claim(itemId, 'import');
    if (sprayItemId !== undefined) claim(sprayItemId, 'proliferator');
    for (const itemId of exportIds) claim(itemId, 'export');
    return [...roles].map(([itemId, role]) => ({ itemId, role }));
  }

  /** Slot-based lower bound: the netlist may need more stations once belt ports are counted. */
  private stationsNeeded(slots: number): number {
    const wantStellar = this.req.stationKind === 'interstellar';
    const station = this.data.data.buildings.find((b) => b.station !== undefined && b.station.isStellar === wantStellar);
    if (!station?.station) {
      throw new PlanFailure({ kind: 'infeasible', message: `GameData has no ${this.req.stationKind} logistics station.` });
    }
    return Math.max(1, Math.ceil(slots / station.station.maxItemKinds));
  }

  private validate(): void {
    const { req } = this;
    try {
      this.data.item(req.targetItemId);
    } catch {
      throw new PlanFailure({ kind: 'infeasible', message: `Unknown target item ${req.targetItemId}.` });
    }
    const amount = req.quantity.kind === 'rate' ? req.quantity.perSecond : req.quantity.count;
    if (!Number.isFinite(amount) || amount <= 0) {
      const what = req.quantity.kind === 'rate' ? 'rate' : 'building count';
      throw new PlanFailure({ kind: 'infeasible', message: `The requested ${what} must be a positive number (got ${amount}).` });
    }
  }

  // -- LP ----------------------------------------------------------------------------------

  /**
   * Variables: x<recipe> crafts/s, i<item> imports (supplied items), e<item> exports (every item).
   * Rows, per item: Σ (out·multiplier − in)·x + i − e = R for the target, 0 otherwise. `pin` fixes
   * one recipe's crafts/s (buildings mode).
   */
  private async solve(nodes: Node[], required: number, pin?: { recipeId: number; crafts: number }) {
    const target = this.req.targetItemId;
    const coefs = new Map<number, Map<number, number>>(); // item -> recipe -> net coefficient
    const add = (itemId: number, recipeId: number, delta: number) => {
      let row = coefs.get(itemId);
      if (!row) coefs.set(itemId, (row = new Map()));
      row.set(recipeId, (row.get(recipeId) ?? 0) + delta);
    };
    for (const n of nodes) {
      for (const i of n.recipe.inputs) add(i.itemId, n.recipe.id, -i.count);
      for (const o of n.recipe.outputs) add(o.itemId, n.recipe.id, o.count * n.effect.outputMultiplier);
    }
    const variables: LPVariable[] = nodes.map((n) => ({
      name: `x${n.recipe.id}`,
      cost: COST_MACHINE * n.secondsPerCraft,
    }));
    const constraints: LPConstraint[] = [];
    for (const [itemId, row] of [...coefs].sort((a, b) => a[0] - b[0])) {
      const terms = [...row].filter(([, coef]) => coef !== 0).map(([recipeId, coef]) => ({ variable: `x${recipeId}`, coef }));
      const imported = this.supplied.has(itemId);
      if (imported) {
        variables.push({ name: `i${itemId}`, cost: COST_IMPORT });
        terms.push({ variable: `i${itemId}`, coef: 1 });
      }
      variables.push({ name: `e${itemId}`, cost: COST_EXPORT });
      terms.push({ variable: `e${itemId}`, coef: -1 });
      constraints.push({ name: `r${itemId}`, terms, type: 'eq', rhs: itemId === target ? required : 0 });
    }
    if (pin) constraints.push({ name: 'pin', terms: [{ variable: `x${pin.recipeId}`, coef: 1 }], type: 'eq', rhs: pin.crafts });
    const solution = await solveLP({ variables, constraints });
    if (solution.status !== 'optimal') {
      throw new PlanFailure({
        kind: 'infeasible',
        message: `No production plan exists for ${this.itemName(target)} with these recipes and supplies (solver: ${solution.status}).`,
      });
    }
    return solution;
  }

  // -- stages and flows --------------------------------------------------------------------

  /** Breadth-first from the target through the stages, so the final stage comes first. */
  private stageOrder(active: Node[]): Node[] {
    const ordered: Node[] = [];
    const placed = new Set<number>();
    const seen = new Set<number>([this.req.targetItemId]);
    const queue = [this.req.targetItemId];
    for (let i = 0; i < queue.length; i++) {
      for (const n of active) {
        if (placed.has(n.recipe.id) || !n.recipe.outputs.some((o) => o.itemId === queue[i])) continue;
        placed.add(n.recipe.id);
        ordered.push(n);
        for (const input of n.recipe.inputs) {
          if (seen.has(input.itemId)) continue;
          seen.add(input.itemId);
          queue.push(input.itemId);
        }
      }
    }
    for (const n of active) if (!placed.has(n.recipe.id)) ordered.push(n);
    return ordered;
  }

  private stageOf(n: Node, x: number): Stage {
    const { recipe, building, effect } = n;
    const exact = x * n.secondsPerCraft;
    const machines = Math.max(1, Math.ceil(exact - EPS));
    const rates = (list: { itemId: number; count: number }[], multiplier: number): ItemRate[] => {
      const merged = new Map<number, number>();
      for (const { itemId, count } of list) merged.set(itemId, (merged.get(itemId) ?? 0) + count * multiplier * x);
      return [...merged].map(([itemId, perSecond]) => ({ itemId, perSecond }));
    };
    return {
      recipeId: recipe.id,
      buildingItemId: building.itemId,
      machines,
      exactMachines: exact,
      craftsPerSecond: x,
      utilization: exact / machines,
      inputs: rates(recipe.inputs, 1),
      outputs: rates(recipe.outputs, effect.outputMultiplier),
      perMachineCraftsPerSecond: 1 / n.secondsPerCraft,
      proliferated: effect.proliferated,
      effectiveSpeed: n.effectiveSpeed,
      workPowerW: building.power.workPerTick * this.data.data.constants.ticksPerSecond * effect.powerMultiplier,
      idlePowerW: building.power.idlePerTick * this.data.data.constants.ticksPerSecond,
    };
  }

  /**
   * Splits every item's production among its consumption: producers (stages in order, then the
   * import) fill consumers (stages in order, then the export) one after the other.
   */
  private flows(stages: Stage[], importRate: Map<number, number>, exportRate: Map<number, number>): Flow[] {
    const itemIds = new Set<number>([...importRate.keys(), ...exportRate.keys()]);
    for (const s of stages) {
      for (const i of s.inputs) itemIds.add(i.itemId);
      for (const o of s.outputs) itemIds.add(o.itemId);
    }
    const flows: Flow[] = [];
    for (const itemId of [...itemIds].sort((a, b) => a - b)) {
      const producers: { from: number | 'import'; left: number }[] = [];
      const consumers: { to: number | 'export'; left: number }[] = [];
      stages.forEach((s, i) => {
        const made = s.outputs.find((o) => o.itemId === itemId)?.perSecond ?? 0;
        if (made > EPS) producers.push({ from: i, left: made });
        const used = s.inputs.find((x) => x.itemId === itemId)?.perSecond ?? 0;
        if (used > EPS) consumers.push({ to: i, left: used });
      });
      const imported = importRate.get(itemId) ?? 0;
      if (imported > EPS) producers.push({ from: 'import', left: imported });
      const exported = exportRate.get(itemId) ?? 0;
      if (exported > EPS) consumers.push({ to: 'export', left: exported });

      let p = 0;
      let c = 0;
      while (p < producers.length && c < consumers.length) {
        const amount = Math.min(producers[p].left, consumers[c].left);
        if (amount > EPS) flows.push({ itemId, from: producers[p].from, to: consumers[c].to, perSecond: amount });
        producers[p].left -= amount;
        consumers[c].left -= amount;
        if (producers[p].left <= EPS) p++;
        if (consumers[c].left <= EPS) c++;
      }
    }
    return flows;
  }
}

export async function planProduction(req: PlanRequest, data: GameDataIndex, effects: TechEffects): Promise<PlanResult> {
  try {
    return { ok: true, plan: await new Planner(req, data, effects).plan() };
  } catch (error) {
    if (error instanceof PlanFailure) return { ok: false, error: error.error };
    throw error;
  }
}
