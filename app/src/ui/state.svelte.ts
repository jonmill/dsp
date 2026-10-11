/* eslint-disable svelte/prefer-svelte-reactivity --
   The Sets here are values inside `$state.raw` objects: built once, never mutated after they are
   stored, and replaced with the whole request. Reactivity comes from the replacement, and the
   planner (plain TS) takes plain Sets. */
/**
 * The app's runes store: the plan request the user is editing, the tech profiles, and the plan
 * computed from them.
 *
 * Recompute is driven by the mutators, not by an `$effect`: a module-level effect has no component
 * to belong to and throws `effect_orphan`. Every mutator calls `scheduleRecompute()` (150 ms
 * debounce); `recompute()` runs now, and `whenSettled()` resolves once nothing is pending. The
 * request is replaced, never edited in place (it holds Sets, which runes do not track), so
 * `$state.raw` is enough.
 */
import { compatibleFacilities, isPlannableRecipe, planProduction, plannableProducers } from '../lib/calc';
import type { PlanRequest, PlanResult, ProliferatorSetting } from '../lib/calc';
import { allTechs, computeTechEffects, GameDataIndex, techClosure } from '../lib/data';
import type { Building, GameData, Item, Recipe, TechEffects } from '../lib/data';
import { geometryBadge } from './format';
import { buildTree, treeLeaves } from './tree';
import type { TreeRow } from './tree';

/** The always-present profile that unlocks every tech. It is never stored. */
export const UNLOCK_ALL_PROFILE = 'Unlock all';
/** localStorage key: `Record<profile name, tech id[]>`. */
export const PROFILES_KEY = 'dsp-planner.techProfiles.v1';
/** localStorage key: the name of the profile selected last (so a reload keeps it). */
export const ACTIVE_PROFILE_KEY = 'dsp-planner.activeProfile.v1';

export const DEBOUNCE_MS = 150;
export const DEFAULT_SOLVER_BUDGET_MINUTES = 10;

/** Water and crude oil are pumped, not mined, so they are not typed RESOURCE; they are still raw. */
const EXTRA_RAW_ITEMS = [1000, 1007];

/** The station charge slider moves in 3 MW steps (50000 J/tick). */
const STATION_CHARGE_STEP = 50_000;

const NO_TARGET: PlanResult = { ok: false, error: { kind: 'infeasible', message: 'No target selected.' } };

export interface StationChargeRange {
  /** J/tick, per MX 6.3: `[work/2, work*5]`. */
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface AppState {
  readonly data: GameData;
  readonly index: GameDataIndex;
  readonly request: PlanRequest;
  readonly effects: TechEffects;
  /** The latest plan, or null before the first one and while no target is picked. */
  readonly plan: PlanResult | null;
  /** A recompute is scheduled or running. */
  readonly computing: boolean;
  readonly hasTarget: boolean;
  /** Selected profile: a stored name, `UNLOCK_ALL_PROFILE`, or '' when the selection was edited by hand. */
  readonly techProfileName: string;
  /** Stored profiles (not the built-in one). */
  readonly profiles: Readonly<Record<string, number[]>>;
  /** How rates are displayed; the request always holds items per second. */
  readonly rateUnit: 's' | 'min';
  /** Kept for the layout solver; nothing reads it yet. */
  readonly solverBudgetMinutes: number;
  /** "Geometry: approximate ..." while GameData geometry is approximate, else null. */
  readonly geometryBadge: string | null;
  /** The Inputs tree, from the target down. */
  readonly tree: TreeRow[];
  /** Unlocked buildings that can run the target's recipe, slowest first. */
  readonly targetFacilityChoices: Building[];
  readonly stationChargeRange: StationChargeRange;

  setTarget(itemId: number): void;
  clearTarget(): void;
  setQuantity(quantity: PlanRequest['quantity']): void;
  setRateUnit(unit: 's' | 'min'): void;
  setFinalFacility(buildingItemId: number): void;
  setSupplied(itemId: number, supplied: boolean): void;
  toggleSupplied(itemId: number): void;
  setProliferator(setting: ProliferatorSetting): void;
  setStationKind(kind: PlanRequest['stationKind']): void;
  /** J/tick, clamped to the slider range; undefined restores the default for the station kind. */
  setStationCharge(perTick: number | undefined): void;
  setFacilityOverride(recipeId: number, buildingItemId: number | undefined): void;
  setRecipeOverride(itemId: number, recipeId: number | undefined): void;
  setSolverBudgetMinutes(minutes: number): void;

  setUnlockedTechs(techIds: Iterable<number>): void;
  toggleTech(techId: number): void;
  /** Sets the selection to exactly the tech and everything it needs. */
  unlockUpTo(techId: number): void;
  unlockAll(): void;
  selectProfile(name: string): void;
  /** Stores the current selection under `name`; false if the name is empty or reserved. */
  saveProfile(name: string): boolean;
  deleteProfile(name: string): void;

  /** Items that can be a target and match `query` (case-insensitive substring of the English name). */
  searchTargets(query: string): Item[];
  /** Unlocked buildings that can run the recipe, slowest first. */
  facilityChoices(recipeId: number): Building[];
  /** Unlocked recipes that make the item. */
  recipeChoices(itemId: number): Recipe[];

  /** Plans now, cancelling a pending debounce. Resolves with the result it computed. */
  recompute(): Promise<PlanResult>;
  /** Resolves when no recompute is scheduled or running. */
  whenSettled(): Promise<void>;
}

// -- localStorage: every access can throw (blocked, full, absent), none of them may break the app --

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage is a convenience; the in-memory state carries on.
  }
}

/** Stored profiles with every tech id checked against `known` (unknown ids would throw in computeTechEffects). */
function loadProfiles(known: Set<number>): Record<string, number[]> {
  const raw = readStorage(PROFILES_KEY);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const entries: [string, number[]][] = [];
  for (const [name, ids] of Object.entries(parsed)) {
    if (name === '' || name === UNLOCK_ALL_PROFILE || !Array.isArray(ids)) continue;
    entries.push([name, ids.filter((id): id is number => typeof id === 'number' && known.has(id))]);
  }
  return Object.fromEntries(entries);
}

// -- target, supplies and facilities ---------------------------------------------------------

function isRaw(item: Item): boolean {
  return item.type.toUpperCase() === 'RESOURCE' || EXTRA_RAW_ITEMS.includes(item.id);
}

/**
 * The recipes the target will be made with: the forced one (`recipeOverrides`) if it is unlocked,
 * else every unlocked recipe that makes it; if none is unlocked, the plannable ones (so the
 * planner's error can name what is locked).
 */
function targetRecipes(index: GameDataIndex, effects: TechEffects, itemId: number, forced: number | undefined): Recipe[] {
  const unlocked = plannableProducers(itemId, index, effects);
  const pinned = unlocked.filter((r) => r.id === forced);
  if (pinned.length > 0) return pinned;
  return unlocked.length > 0 ? unlocked : index.recipesProducing(itemId).filter(isPlannableRecipe);
}

/** The fastest unlocked building for the target's main recipe; failing that the first one to unlock. */
function defaultFinalFacility(
  index: GameDataIndex,
  effects: TechEffects,
  itemId: number,
  forced: number | undefined,
): number {
  const recipes = targetRecipes(index, effects, itemId, forced);
  const recipe = recipes.find((r) => !r.explicit) ?? recipes[0];
  if (!recipe) return 0;
  const all = compatibleFacilities(recipe, index);
  const unlocked = all.filter((b) => effects.availableBuildings.has(b.itemId));
  return (unlocked.at(-1) ?? all[0])?.itemId ?? 0;
}

/** Can this unlocked building run one of the recipes the target will be made with? */
function finalFacilityFits(
  index: GameDataIndex,
  effects: TechEffects,
  itemId: number,
  forced: number | undefined,
  buildingItemId: number,
): boolean {
  if (!effects.availableBuildings.has(buildingItemId)) return false;
  return targetRecipes(index, effects, itemId, forced).some((r) =>
    compatibleFacilities(r, index).some((b) => b.itemId === buildingItemId),
  );
}

/** `request` with the leaves under its target added to the supplied set. */
function withLeavesSupplied(index: GameDataIndex, effects: TechEffects, request: PlanRequest): PlanRequest {
  const missing = treeLeaves(index, effects, request).filter((id) => !request.suppliedItemIds.has(id));
  if (missing.length === 0) return request;
  return { ...request, suppliedItemIds: new Set([...request.suppliedItemIds, ...missing]) };
}

export function createAppState(data: GameData): AppState {
  const index = new GameDataIndex(data);
  const knownTechs = allTechs(data);
  const badge = geometryBadge(data);

  // Items some plannable recipe makes: the only ones worth offering as a target.
  const producible = new Set<number>();
  for (const recipe of data.recipes) {
    if (!isPlannableRecipe(recipe)) continue;
    for (const { itemId } of recipe.outputs) producible.add(itemId);
  }
  const targetItems = data.items.filter((item) => producible.has(item.id));

  // -- initial state ----------------------------------------------------------------------

  const storedProfiles = loadProfiles(knownTechs);
  const lastProfile = readStorage(ACTIVE_PROFILE_KEY);
  const initialName =
    lastProfile !== null && Object.hasOwn(storedProfiles, lastProfile) ? lastProfile : UNLOCK_ALL_PROFILE;
  const initialTechs = initialName === UNLOCK_ALL_PROFILE ? knownTechs : new Set(storedProfiles[initialName]);

  let profiles = $state.raw<Record<string, number[]>>(storedProfiles);
  let techProfileName = $state(initialName);
  let effects = $state.raw<TechEffects>(computeTechEffects(data, initialTechs));
  let request = $state.raw<PlanRequest>({
    targetItemId: 0,
    quantity: { kind: 'rate', perSecond: 1 },
    finalFacilityItemId: 0,
    unlockedTechs: new Set(initialTechs),
    suppliedItemIds: new Set(data.items.filter(isRaw).map((item) => item.id)),
    facilityOverrides: {},
    recipeOverrides: {},
    proliferator: { tier: 0, mode: 'extra' },
    stationKind: 'planetary',
  });
  let plan = $state.raw<PlanResult | null>(null);
  let rateUnit = $state<'s' | 'min'>('s');
  let solverBudgetMinutes = $state(DEFAULT_SOLVER_BUDGET_MINUTES);
  let computing = $state(false);

  // -- recompute --------------------------------------------------------------------------

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = 0;
  /** Bumped by every recompute; a result is kept only if no later one has started. */
  let latest = 0;
  let waiters: (() => void)[] = [];
  /** The user picked the final facility; until then it follows the techs (fastest unlocked). */
  let finalFacilityPinned = false;

  function settleIfIdle(): void {
    if (timer !== undefined || running > 0) return;
    computing = false;
    const woken = waiters;
    waiters = [];
    for (const wake of woken) wake();
  }

  async function runPlan(req: PlanRequest, eff: TechEffects): Promise<PlanResult> {
    try {
      return await planProduction(req, index, eff);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { kind: 'infeasible', message: `The planner failed: ${reason}` } };
    }
  }

  function recompute(): Promise<PlanResult> {
    clearTimeout(timer);
    timer = undefined;
    const mine = ++latest;
    if (request.targetItemId === 0) {
      plan = null;
      settleIfIdle();
      return Promise.resolve(NO_TARGET);
    }
    running++;
    computing = true;
    return runPlan(request, effects).then((result) => {
      if (mine === latest) plan = result;
      running--;
      settleIfIdle();
      return result;
    });
  }

  function scheduleRecompute(): void {
    clearTimeout(timer);
    computing = true;
    timer = setTimeout(() => {
      timer = undefined;
      void recompute();
    }, DEBOUNCE_MS);
  }

  function whenSettled(): Promise<void> {
    if (timer === undefined && running === 0) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  }

  // -- mutators ---------------------------------------------------------------------------

  /** Replaces the request and schedules a plan. */
  function update(next: PlanRequest): void {
    request = next;
    scheduleRecompute();
  }

  function setProfileName(name: string): void {
    techProfileName = name;
    writeStorage(ACTIVE_PROFILE_KEY, name);
  }

  /**
   * The final facility for `req`: the user's pick while it still runs the target's recipe,
   * else the default (fastest unlocked building for that recipe). Call after anything that can
   * change the target, its recipe or what is unlocked.
   */
  function withFinalFacility(req: PlanRequest, eff: TechEffects): PlanRequest {
    if (req.targetItemId === 0) return req;
    const forced = req.recipeOverrides[req.targetItemId];
    if (finalFacilityPinned && finalFacilityFits(index, eff, req.targetItemId, forced, req.finalFacilityItemId)) {
      return req;
    }
    finalFacilityPinned = false; // a pick that no longer fits is dropped
    return { ...req, finalFacilityItemId: defaultFinalFacility(index, eff, req.targetItemId, forced) };
  }

  /** Applies a tech selection: effects, the final facility if it stopped fitting, and new leaves. */
  function applyTechs(ids: Iterable<number>, profileName: string): void {
    const unlockedTechs = new Set([...ids].filter((id) => knownTechs.has(id)));
    const nextEffects = computeTechEffects(data, unlockedTechs);
    let next: PlanRequest = { ...request, unlockedTechs };
    if (next.targetItemId !== 0) {
      next = withLeavesSupplied(index, nextEffects, withFinalFacility(next, nextEffects));
    }
    effects = nextEffects;
    setProfileName(profileName);
    update(next);
  }

  function setTarget(itemId: number): void {
    index.item(itemId); // throws, naming the id, if GameData does not have it
    finalFacilityPinned = false;
    const supplied = new Set(request.suppliedItemIds);
    supplied.delete(itemId);
    const next: PlanRequest = { ...request, targetItemId: itemId, suppliedItemIds: supplied };
    update(withLeavesSupplied(index, effects, withFinalFacility(next, effects)));
  }

  function setSupplied(itemId: number, supplied: boolean): void {
    if (itemId === request.targetItemId || request.suppliedItemIds.has(itemId) === supplied) return;
    const next = new Set(request.suppliedItemIds);
    if (supplied) next.add(itemId);
    else next.delete(itemId);
    let req: PlanRequest = { ...request, suppliedItemIds: next };
    // Making an item pulls in its inputs, some of which may be leaves. A leaf the user just
    // un-supplied is left alone, so the plan can name it.
    if (!supplied && plannableProducers(itemId, index, effects).length > 0) {
      req = withLeavesSupplied(index, effects, req);
    }
    update(req);
  }

  function stationRange(kind: PlanRequest['stationKind']): StationChargeRange {
    const fallback = data.constants.stationDefaultChargePerTick[kind];
    const station = data.buildings.find((b) => b.station?.isStellar === (kind === 'interstellar'));
    const work = station?.power.workPerTick ?? fallback;
    return { min: work / 2, max: work * 5, step: STATION_CHARGE_STEP, default: fallback };
  }

  function facilityChoices(recipeId: number): Building[] {
    return compatibleFacilities(index.recipe(recipeId), index).filter((b) => effects.availableBuildings.has(b.itemId));
  }

  return {
    data,
    index,
    get request() {
      return request;
    },
    get effects() {
      return effects;
    },
    get plan() {
      return plan;
    },
    get computing() {
      return computing;
    },
    get hasTarget() {
      return request.targetItemId !== 0;
    },
    get techProfileName() {
      return techProfileName;
    },
    get profiles() {
      return profiles;
    },
    get rateUnit() {
      return rateUnit;
    },
    get solverBudgetMinutes() {
      return solverBudgetMinutes;
    },
    geometryBadge: badge,
    get tree() {
      return buildTree(index, effects, request, plan);
    },
    get targetFacilityChoices() {
      const seen = new Set<number>();
      const choices: Building[] = [];
      for (const recipe of plannableProducers(request.targetItemId, index, effects)) {
        for (const building of facilityChoices(recipe.id)) {
          if (seen.has(building.itemId)) continue;
          seen.add(building.itemId);
          choices.push(building);
        }
      }
      return choices;
    },
    get stationChargeRange() {
      return stationRange(request.stationKind);
    },

    setTarget,
    clearTarget() {
      update({ ...request, targetItemId: 0, finalFacilityItemId: 0 });
    },
    setQuantity(quantity) {
      update({ ...request, quantity });
    },
    setRateUnit(unit) {
      rateUnit = unit;
    },
    setFinalFacility(buildingItemId) {
      finalFacilityPinned = true;
      update({ ...request, finalFacilityItemId: buildingItemId });
    },
    setSupplied,
    toggleSupplied(itemId) {
      setSupplied(itemId, !request.suppliedItemIds.has(itemId));
    },
    setProliferator(setting) {
      update({ ...request, proliferator: { ...setting } });
    },
    setStationKind(kind) {
      update({ ...request, stationKind: kind, stationChargePerTick: undefined });
    },
    setStationCharge(perTick) {
      if (perTick === undefined || !Number.isFinite(perTick)) {
        update({ ...request, stationChargePerTick: undefined });
        return;
      }
      const { min, max } = stationRange(request.stationKind);
      update({ ...request, stationChargePerTick: Math.min(max, Math.max(min, perTick)) });
    },
    setFacilityOverride(recipeId, buildingItemId) {
      const overrides = { ...request.facilityOverrides };
      if (buildingItemId === undefined) delete overrides[recipeId];
      else overrides[recipeId] = buildingItemId;
      update({ ...request, facilityOverrides: overrides });
    },
    setRecipeOverride(itemId, recipeId) {
      const overrides = { ...request.recipeOverrides };
      if (recipeId === undefined) delete overrides[itemId];
      else overrides[itemId] = recipeId;
      const next: PlanRequest = { ...request, recipeOverrides: overrides };
      update(withLeavesSupplied(index, effects, withFinalFacility(next, effects)));
    },
    setSolverBudgetMinutes(minutes) {
      if (Number.isFinite(minutes) && minutes > 0) solverBudgetMinutes = minutes;
    },

    setUnlockedTechs(techIds) {
      applyTechs(techIds, '');
    },
    toggleTech(techId) {
      if (!knownTechs.has(techId)) return;
      const next = new Set(request.unlockedTechs);
      if (!next.delete(techId)) next.add(techId);
      applyTechs(next, '');
    },
    unlockUpTo(techId) {
      if (!knownTechs.has(techId)) return;
      applyTechs(techClosure(data, [techId]), '');
    },
    unlockAll() {
      applyTechs(knownTechs, UNLOCK_ALL_PROFILE);
    },
    selectProfile(name) {
      if (name === UNLOCK_ALL_PROFILE) applyTechs(knownTechs, UNLOCK_ALL_PROFILE);
      else if (Object.hasOwn(profiles, name)) applyTechs(profiles[name], name);
    },
    saveProfile(name) {
      const trimmed = name.trim();
      if (trimmed === '' || trimmed === UNLOCK_ALL_PROFILE) return false;
      profiles = { ...profiles, [trimmed]: [...request.unlockedTechs].sort((a, b) => a - b) };
      writeStorage(PROFILES_KEY, JSON.stringify(profiles));
      setProfileName(trimmed);
      return true;
    },
    deleteProfile(name) {
      if (!Object.hasOwn(profiles, name)) return;
      profiles = Object.fromEntries(Object.entries(profiles).filter(([key]) => key !== name));
      writeStorage(PROFILES_KEY, JSON.stringify(profiles));
      if (techProfileName === name) setProfileName('');
    },

    searchTargets(query) {
      const needle = query.trim().toLowerCase();
      if (needle === '') return [];
      const matches = targetItems.filter((item) => item.name.toLowerCase().includes(needle));
      // Names that start with the query first; the sort is stable, so the rest stay in game order.
      const starts = (item: Item) => (item.name.toLowerCase().startsWith(needle) ? 0 : 1);
      return matches.sort((a, b) => starts(a) - starts(b));
    },
    facilityChoices,
    recipeChoices(itemId) {
      return plannableProducers(itemId, index, effects);
    },

    recompute,
    whenSettled,
  };
}
