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
 *
 * The layout solve (Task 25) hangs off the plan. `startSolve()` runs the solver worker on the current plan; a new
 * solve stops a running one, and its late answer is ignored. Changing the plan while a solve runs, or after it,
 * does not cancel or clear anything: `solve.stale` says the result is for an older plan. `solve.layout` is the best
 * layout so far (it is replaced as the worker reports better ones); `blueprint` is made from it on demand.
 */
import { layoutToBlueprintString } from '../lib/blueprint';
import { compatibleFacilities, isPlannableRecipe, planProduction, plannableProducers } from '../lib/calc';
import type { PlanRequest, PlanResult, ProductionPlan, ProliferatorSetting } from '../lib/calc';
import { allTechs, computeTechEffects, GameDataIndex, techClosure } from '../lib/data';
import type { Building, GameData, Item, Recipe, TechEffects } from '../lib/data';
import type { Layout } from '../lib/geometry';
import { startSolve as startSolveWorker } from '../lib/layout/client';
import type { SolveHandle } from '../lib/layout/client';
import { DEFAULT_SOLVE_OPTIONS } from '../lib/layout/solver';
import type { SolveProgress, SolveResult } from '../lib/layout/solver';
import type { ValidationReport, Violation } from '../lib/validate';
import { formatCount, formatPower, geometryBadge, itemName } from './format';
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

export type SolveStatus = 'idle' | 'running' | 'done' | 'error';

/** The layout solve as the panels see it. Every field is reactive on its own. */
export interface SolveState {
  readonly status: SolveStatus;
  /** A stop was asked for and the solver has not handed back its best yet. */
  readonly stopping: boolean;
  /** The latest progress report; null before the first. */
  readonly progress: SolveProgress | null;
  /** The best layout so far (the final one once `status` is 'done'). */
  readonly layout: Layout | null;
  readonly report: ValidationReport | null;
  /** Plan-view area of `layout`, in tiles. */
  readonly footprint: number | null;
  /** The solver's final answer, once `status` is 'done'. */
  readonly result: SolveResult | null;
  /** Why the solve failed, when `status` is 'error'. */
  readonly error: string | null;
  /** The plan the solve was started on. */
  readonly plan: ProductionPlan | null;
  /** The improvement budget this run was started with. */
  readonly budgetMs: number;
  /** `performance.now()` when this run started. */
  readonly startedAt: number;
  /** The plan has changed since this run started, so the layout is for an older plan. */
  readonly stale: boolean;
}

/** The blueprint made from the best layout, with the texts it is described by. */
export interface BlueprintExport {
  /** The `BLUEPRINT:...` string; empty when building it failed. */
  text: string;
  /** Why `text` is empty. */
  error: string | null;
  /** `<target-name>-<rate>.txt` */
  fileName: string;
  shortDesc: string;
  desc: string;
  /** The layout was built on approximate geometry (Review Focus #5): the UI says so next to the blueprint. */
  approximate: boolean;
}

/** What `createAppState` takes from outside, so a test can stand in for the worker. */
export interface AppDeps {
  startSolve?: typeof startSolveWorker;
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
  /** How long the layout solver may keep improving a layout it already has, in minutes. */
  readonly solverBudgetMinutes: number;
  /** "Geometry: approximate ..." while GameData geometry is approximate, else null. */
  readonly geometryBadge: string | null;
  /** The Inputs tree, from the target down. */
  readonly tree: TreeRow[];
  /** Unlocked buildings that can run the target's recipe, slowest first. */
  readonly targetFacilityChoices: Building[];
  readonly stationChargeRange: StationChargeRange;
  readonly solve: SolveState;
  /** The plan is ok and settled, so a solve can start. */
  readonly canSolve: boolean;
  /** The blueprint of `solve.layout`; null while there is no layout. */
  readonly blueprint: BlueprintExport | null;
  /** The violation the user picked in the report; the preview draws it in red. */
  readonly selectedViolation: Violation | null;

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

  /** Solves the current plan; a solve already running is stopped first. Does nothing unless `canSolve`. */
  startSolve(): void;
  /** Asks the running solve to stop; `solve.layout` is then the best found so far. */
  stopSolve(): void;
  selectViolation(violation: Violation | null): void;
  /** Resolves when no solve is running. */
  whenSolved(): Promise<void>;

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

// -- the solve ---------------------------------------------------------------------------------

/** Two plans are the same when this is: the layout depends on all of it (the unlocked techs limit belts and sorters). */
function planSignature(plan: ProductionPlan): string {
  return JSON.stringify(plan, (_key, value: unknown) =>
    value instanceof Set ? [...value].sort((a, b) => Number(a) - Number(b)) : value,
  );
}

/** The rate the plan provisions for its target: what the layout is built and judged for. */
export function plannedRate(plan: ProductionPlan): number {
  return plan.exports.find((e) => e.itemId === plan.request.targetItemId)?.perSecond ?? plan.actualTargetRate;
}

/** `<target-name>-<rate>.txt`, lower case with dashes: "circuit-board-1.txt". */
export function blueprintFileName(targetName: string, perSecond: number): string {
  const slug = targetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'blueprint' : slug}-${formatCount(perSecond)}.txt`;
}

const MAX_DESC_IMPORTS = 6;

/**
 * The blueprint string for `layout`, titled "<target name> <rate>/s", with a description of the plan it was solved
 * for. The builder itself adds the "geometry: approximate" flag to the description when the layout needs it.
 */
export function makeBlueprint(
  layout: Layout,
  plan: ProductionPlan,
  index: GameDataIndex,
  footprint: number | null,
  report: ValidationReport | null,
): BlueprintExport {
  const target = itemName(index, plan.request.targetItemId);
  const rate = plannedRate(plan);
  const shortDesc = `${target} ${formatCount(rate)}/s`;
  const machines = plan.stages.reduce((n, stage) => n + stage.machines, 0);
  const stations = `${plan.stationsNeeded} station${plan.stationsNeeded === 1 ? '' : 's'}`;
  const imports = plan.imports.slice(0, MAX_DESC_IMPORTS).map((i) => `${itemName(index, i.itemId)} ${formatCount(i.perSecond)}/s`);
  if (plan.imports.length > MAX_DESC_IMPORTS) imports.push('...');
  const power = report?.sim?.power ?? null;
  const lines = [
    `${shortDesc}, ${machines} machines, ${stations}${footprint === null ? '' : `, ${Math.round(footprint)} tiles`}.`,
    imports.length > 0 ? `Supplied: ${imports.join(', ')}.` : 'Nothing supplied.',
    power
      ? `Power (simulated): ${formatPower(power.steadyW)} steady, ${formatPower(power.peakW)} peak.`
      : `Power (estimate): ${formatPower(plan.power.steadyW)} steady, ${formatPower(plan.power.peakW)} peak.`,
    'Made with DSP Factory Planner.',
  ];
  const desc = lines.join('\n');
  const fileName = blueprintFileName(target, rate);
  const approximate = layout.meta.geometrySource === 'approximate';
  try {
    return { text: layoutToBlueprintString(layout, index, { shortDesc, desc }), error: null, fileName, shortDesc, desc, approximate };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { text: '', error: `The blueprint could not be built: ${reason}`, fileName, shortDesc, desc, approximate };
  }
}

export function createAppState(data: GameData, deps: AppDeps = {}): AppState {
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
  /** `planSignature` of `plan` while it is ok. */
  let planSig = $state<string | null>(null);

  // -- the solve's state: replaced as a whole, so $state.raw
  let solveStatus = $state<SolveStatus>('idle');
  let solveStopping = $state(false);
  let solveProgress = $state.raw<SolveProgress | null>(null);
  let bestLayout = $state.raw<Layout | null>(null);
  let bestReport = $state.raw<ValidationReport | null>(null);
  let bestFootprint = $state<number | null>(null);
  let solveResult = $state.raw<SolveResult | null>(null);
  let solveError = $state<string | null>(null);
  let solvePlan = $state.raw<ProductionPlan | null>(null);
  let solveSig = $state<string | null>(null);
  let solveBudgetMs = $state(0);
  let solveStartedAt = $state(0);
  let selectedViolation = $state.raw<Violation | null>(null);

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
      planSig = null;
      settleIfIdle();
      return Promise.resolve(NO_TARGET);
    }
    running++;
    computing = true;
    return runPlan(request, effects).then((result) => {
      if (mine === latest) {
        plan = result;
        planSig = result.ok ? planSignature(result.plan) : null;
      }
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

  // -- solve ------------------------------------------------------------------------------

  const startWorker = deps.startSolve ?? startSolveWorker;
  let handle: SolveHandle | undefined;
  /** Bumped by every solve; the answers of an earlier one are dropped. */
  let solveToken = 0;
  let solveRuns = 0;
  let solveWaiters: (() => void)[] = [];

  function endSolve(): void {
    solveStopping = false;
    handle = undefined;
    const woken = solveWaiters;
    solveWaiters = [];
    for (const wake of woken) wake();
  }

  function startSolve(): void {
    const current = plan?.ok ? plan.plan : null;
    if (!current || computing) return;
    handle?.stop(); // its answer is ignored from here on (the token), and it ends itself
    const mine = ++solveToken;
    const budgetMs = solverBudgetMinutes * 60_000;
    solveStatus = 'running';
    solveStopping = false;
    solveProgress = null;
    bestLayout = null;
    bestReport = null;
    bestFootprint = null;
    solveResult = null;
    solveError = null;
    solvePlan = current;
    solveSig = planSig;
    solveBudgetMs = budgetMs;
    solveStartedAt = performance.now();
    selectedViolation = null;

    const fail = (reason: string): void => {
      solveStatus = 'error';
      solveError = reason;
      endSolve();
    };
    let started: SolveHandle;
    try {
      started = startWorker(
        current,
        index,
        effects,
        { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: budgetMs, seed: DEFAULT_SOLVE_OPTIONS.seed + solveRuns++ },
        {
          onProgress: (progress) => {
            if (mine === solveToken) solveProgress = progress;
          },
          onImproved: (layout, report, footprint) => {
            if (mine !== solveToken) return;
            bestLayout = layout;
            bestReport = report;
            bestFootprint = footprint;
          },
        },
      );
    } catch (error) {
      // No Worker in this environment, or the plan could not even be handed over.
      fail(`The solver could not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    handle = started;
    started.done.then(
      (result) => {
        if (mine !== solveToken) return;
        solveResult = result;
        if (result.layout) {
          bestLayout = result.layout;
          bestReport = result.report;
          bestFootprint = result.footprint;
        }
        solveStatus = 'done';
        endSolve();
      },
      (error: unknown) => {
        if (mine === solveToken) fail(error instanceof Error ? error.message : String(error));
      },
    );
  }

  function stopSolve(): void {
    if (solveStatus !== 'running' || solveStopping) return;
    solveStopping = true;
    handle?.stop();
  }

  function whenSolved(): Promise<void> {
    if (solveStatus !== 'running') return Promise.resolve();
    return new Promise((resolve) => solveWaiters.push(resolve));
  }

  const solveView: SolveState = {
    get status() {
      return solveStatus;
    },
    get stopping() {
      return solveStopping;
    },
    get progress() {
      return solveProgress;
    },
    get layout() {
      return bestLayout;
    },
    get report() {
      return bestReport;
    },
    get footprint() {
      return bestFootprint;
    },
    get result() {
      return solveResult;
    },
    get error() {
      return solveError;
    },
    get plan() {
      return solvePlan;
    },
    get budgetMs() {
      return solveBudgetMs;
    },
    get startedAt() {
      return solveStartedAt;
    },
    get stale() {
      return solveStatus !== 'idle' && solveSig !== planSig;
    },
  };

  // Built when asked for, and again only when the layout, its plan, footprint or report is a different object:
  // progress reports must not re-encode the string.
  let blueprintMemo:
    | { layout: Layout; plan: ProductionPlan; footprint: number | null; report: ValidationReport | null; value: BlueprintExport }
    | undefined;
  function blueprintOfBest(): BlueprintExport | null {
    const layout = bestLayout;
    const plan = solvePlan;
    const footprint = bestFootprint;
    const report = bestReport;
    if (!layout || !plan) return null;
    const memo = blueprintMemo;
    if (memo && memo.layout === layout && memo.plan === plan && memo.footprint === footprint && memo.report === report) {
      return memo.value;
    }
    const value = makeBlueprint(layout, plan, index, footprint, report);
    blueprintMemo = { layout, plan, footprint, report, value };
    return value;
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
    solve: solveView,
    get canSolve() {
      return plan?.ok === true && !computing;
    },
    get blueprint() {
      return blueprintOfBest();
    },
    get selectedViolation() {
      return selectedViolation;
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

    startSolve,
    stopSolve,
    selectViolation(violation) {
      selectedViolation = violation;
    },
    whenSolved,

    recompute,
    whenSettled,
  };
}
