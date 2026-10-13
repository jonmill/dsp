import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFixtureGameData } from '../../test/fixtures/fixtureGameData';
import { planProduction } from '../lib/calc';
import type { PlanResult, ProductionPlan } from '../lib/calc';
import { decodeBlueprint } from '../lib/blueprint';
import { allTechs, GameDataIndex, techClosure } from '../lib/data';
import type { SolveResult } from '../lib/layout/solver';
import { compositeLayout, stationPairLayout } from '../lib/validate/testkit';
import type { Violation } from '../lib/validate';
import { formatCount, formatPower } from './format';
import { blueprintFileName, createAppState, makeBlueprint, PROFILES_KEY, UNLOCK_ALL_PROFILE } from './state.svelte';
import type { AppDeps, AppState } from './state.svelte';

// Pass-through spy: most tests run the real planner, the stale-result tests substitute one call.
vi.mock('../lib/calc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/calc')>();
  return { ...real, planProduction: vi.fn(real.planProduction) };
});

const data = loadFixtureGameData();
const everything = allTechs(data);

const PROCESSOR = 1303;
const IRON_INGOT = 1101;
const IRON_ORE = 1001;
const WATER = 1000;
const CRUDE_OIL = 1007;
const RECOMPOSING_ASSEMBLER = 2318;

const PROCESSOR_RECIPE = 51;
const IRON_INGOT_RECIPE = 1;
/** The tech that unlocks the Processor recipe. */
const PROCESSOR_TECH = 1302;

function okPlan(result: PlanResult | null): ProductionPlan {
  if (!result?.ok) throw new Error(`expected an ok plan, got ${JSON.stringify(result)}`);
  return result.plan;
}

/** An in-memory Storage; `failWith` makes every access throw, like a blocked or full store. */
function memoryStorage(initial: Record<string, string> = {}, failWith?: Error) {
  const map = new Map(Object.entries(initial));
  const guard = () => {
    if (failWith) throw failWith;
  };
  return {
    map,
    getItem: (key: string) => {
      guard();
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      guard();
      map.set(key, value);
    },
    removeItem: (key: string) => {
      guard();
      map.delete(key);
    },
  };
}

/** Every state a test created, so afterEach can finish their pending recomputes. */
const created: AppState[] = [];

function createApp(deps?: AppDeps): AppState {
  const app = createAppState(data, deps);
  created.push(app);
  return app;
}

beforeEach(() => {
  vi.mocked(planProduction).mockClear();
});

afterEach(async () => {
  if (vi.isFakeTimers()) {
    // Debounce timers are fake: drop them rather than wait for time that never passes.
    vi.clearAllTimers();
  } else {
    // A mutator leaves a 150 ms timer behind. Run the plan now, so no timer or planner call
    // outlives the test and lands in the next one.
    await Promise.all(created.map((app) => app.recompute().then(() => app.whenSettled())));
  }
  created.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('defaults', () => {
  it('starts with no target, no plan and every tech unlocked', () => {
    const app = createApp();
    expect(app.hasTarget).toBe(false);
    expect(app.plan).toBeNull();
    expect(app.techProfileName).toBe(UNLOCK_ALL_PROFILE);
    expect(app.request.unlockedTechs).toEqual(everything);
  });

  it('supplies raw resources, water and crude oil, and nothing else', () => {
    const app = createApp();
    const supplied = app.request.suppliedItemIds;
    for (const item of data.items.filter((i) => i.type === 'RESOURCE')) expect(supplied.has(item.id)).toBe(true);
    expect(supplied.has(WATER)).toBe(true);
    expect(supplied.has(CRUDE_OIL)).toBe(true);
    expect(supplied.has(IRON_INGOT)).toBe(false);
  });

  it('shows the fixture geometry badge', () => {
    expect(createApp().geometryBadge).toBe('Geometry: approximate (fixture data)');
  });

  it('defaults the solver budget to 10 minutes and the rate unit to per second', () => {
    const app = createApp();
    expect(app.solverBudgetMinutes).toBe(10);
    expect(app.rateUnit).toBe('s');
  });

  it('recompute without a target resolves to an error and leaves the plan empty', async () => {
    const app = createApp();
    const result = await app.recompute();
    expect(result.ok).toBe(false);
    expect(app.plan).toBeNull();
  });
});

describe('target and plan', () => {
  it('plans the Processor once the debounce has passed', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    app.setQuantity({ kind: 'rate', perSecond: 1 });
    await app.whenSettled();
    const plan = okPlan(app.plan);
    expect(plan.stages.some((s) => s.recipeId === PROCESSOR_RECIPE)).toBe(true);
    expect(plan.actualTargetRate).toBeGreaterThanOrEqual(1);
  });

  it('defaults the final facility to the fastest unlocked building for the target recipe', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    expect(app.request.finalFacilityItemId).toBe(RECOMPOSING_ASSEMBLER);
    await app.whenSettled();
    const stage = okPlan(app.plan).stages.find((s) => s.recipeId === PROCESSOR_RECIPE);
    expect(stage?.buildingItemId).toBe(RECOMPOSING_ASSEMBLER);
  });

  it('lists the facilities for the target recipe, slowest first', () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    expect(app.targetFacilityChoices.map((b) => b.itemId)).toEqual([2303, 2304, 2305, 2318]);
  });

  it('removes the Iron Ingot stage when Iron Ingot is supplied', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    await app.whenSettled();
    expect(okPlan(app.plan).stages.some((s) => s.recipeId === IRON_INGOT_RECIPE)).toBe(true);

    app.toggleSupplied(IRON_INGOT);
    expect(app.request.suppliedItemIds.has(IRON_INGOT)).toBe(true);
    const result = await app.recompute();
    expect(app.plan).toBe(result);
    const plan = okPlan(result);
    expect(plan.stages.some((s) => s.recipeId === IRON_INGOT_RECIPE)).toBe(false);
    expect(plan.imports.some((i) => i.itemId === IRON_INGOT)).toBe(true);

    app.toggleSupplied(IRON_INGOT);
    expect(app.request.suppliedItemIds.has(IRON_INGOT)).toBe(false);
  });

  it('never supplies the target', () => {
    const app = createApp();
    app.toggleSupplied(IRON_INGOT);
    app.setTarget(IRON_INGOT);
    expect(app.request.suppliedItemIds.has(IRON_INGOT)).toBe(false);
  });

  it('supplies the leaves under the target (items nothing unlocked makes)', () => {
    const app = createApp();
    app.toggleSupplied(IRON_ORE);
    expect(app.request.suppliedItemIds.has(IRON_ORE)).toBe(false);
    app.setTarget(PROCESSOR);
    expect(app.request.suppliedItemIds.has(IRON_ORE)).toBe(true);
  });

  it('supplies a non-raw leaf created by a small tech selection', () => {
    const app = createApp();
    app.setUnlockedTechs(techClosure(data, [PROCESSOR_TECH]));
    app.setTarget(PROCESSOR);
    // High-purity Silicon needs a recipe from a later tech, so with this selection it is a leaf.
    expect(app.request.suppliedItemIds.has(1105)).toBe(true);
  });

  it('clears the target and the plan', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    await app.whenSettled();
    expect(app.plan).not.toBeNull();
    app.clearTarget();
    await app.whenSettled();
    expect(app.hasTarget).toBe(false);
    expect(app.plan).toBeNull();
  });

  it('plans a building count', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    app.setQuantity({ kind: 'buildings', count: 2 });
    const plan = okPlan(await app.recompute());
    const stage = plan.stages.find((s) => s.recipeId === PROCESSOR_RECIPE);
    expect(stage?.exactMachines).toBeCloseTo(2, 6);
  });

  it('names the locked tech when the target is locked', async () => {
    const app = createApp();
    app.setUnlockedTechs([]);
    app.setTarget(PROCESSOR);
    const result = await app.recompute();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('target-locked');
      expect(result.error.message).toContain('Research');
    }
  });
});

describe('options', () => {
  it('applies facility overrides', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    app.setFacilityOverride(IRON_INGOT_RECIPE, 2302);
    const plan = okPlan(await app.recompute());
    expect(plan.stages.find((s) => s.recipeId === IRON_INGOT_RECIPE)?.buildingItemId).toBe(2302);
    app.setFacilityOverride(IRON_INGOT_RECIPE, undefined);
    expect(app.request.facilityOverrides[IRON_INGOT_RECIPE]).toBeUndefined();
  });

  it('applies alternate-recipe choices', async () => {
    const app = createApp();
    expect(app.recipeChoices(1123).map((r) => r.id)).toEqual([31, 32]);
    app.setTarget(1123);
    app.setRecipeOverride(1123, 32);
    const plan = okPlan(await app.recompute());
    expect(plan.stages.some((s) => s.recipeId === 32)).toBe(true);
    expect(plan.stages.some((s) => s.recipeId === 31)).toBe(false);
  });

  it('sets the proliferator and plans with it', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    app.setProliferator({ tier: 3, mode: 'speed' });
    expect(app.request.proliferator).toEqual({ tier: 3, mode: 'speed' });
    const plan = okPlan(await app.recompute());
    expect(plan.proliferatorPerSecond).toBeGreaterThan(0);
  });

  it('changes the station charge and resets it when the station kind changes', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    const base = okPlan(await app.recompute()).power.stationChargeW;
    app.setStationCharge(100_000);
    expect(app.request.stationChargePerTick).toBe(100_000);
    const half = okPlan(await app.recompute()).power.stationChargeW;
    expect(half).toBeCloseTo(base / 2, 6);

    app.setStationKind('interstellar');
    expect(app.request.stationKind).toBe('interstellar');
    expect(app.request.stationChargePerTick).toBeUndefined();
  });

  it('exposes the station charge range as [work/2, work*5] J/tick', () => {
    const app = createApp();
    expect(app.stationChargeRange).toEqual({ min: 100_000, max: 1_000_000, step: 50_000, default: 200_000 });
    app.setStationKind('interstellar');
    expect(app.stationChargeRange).toEqual({ min: 500_000, max: 5_000_000, step: 50_000, default: 1_000_000 });
  });

  it('stores the solver time budget and rejects non-positive values', () => {
    const app = createApp();
    app.setSolverBudgetMinutes(25);
    expect(app.solverBudgetMinutes).toBe(25);
    app.setSolverBudgetMinutes(0);
    app.setSolverBudgetMinutes(Number.NaN);
    expect(app.solverBudgetMinutes).toBe(25);
  });

  it('plans with a 1 % machine headroom until it is changed, and the counts follow it', async () => {
    const app = createApp();
    expect(app.request.machineHeadroom).toBe(0.01);
    app.setTarget(PROCESSOR);
    const machines = (plan: ProductionPlan): number => plan.stages.reduce((n, s) => n + s.machines, 0);
    const withHeadroom = okPlan(await app.recompute());
    app.setMachineHeadroom(0);
    expect(app.request.machineHeadroom).toBe(0);
    const without = okPlan(await app.recompute());
    expect(machines(withHeadroom)).toBeGreaterThan(machines(without));
    expect(without.stages.every((s) => s.machines === Math.max(1, Math.ceil(s.exactMachines - 1e-9)))).toBe(true);
    expect(without.request.machineHeadroom).toBe(0);
  });

  it('keeps the machine headroom between 0 and 10 %, and ignores what is not a number', () => {
    const app = createApp();
    app.setMachineHeadroom(0.05);
    expect(app.request.machineHeadroom).toBe(0.05);
    app.setMachineHeadroom(-0.02);
    expect(app.request.machineHeadroom).toBe(0);
    app.setMachineHeadroom(0.5);
    expect(app.request.machineHeadroom).toBe(0.1);
    app.setMachineHeadroom(0.03);
    app.setMachineHeadroom(Number.NaN);
    app.setMachineHeadroom(Number.POSITIVE_INFINITY);
    expect(app.request.machineHeadroom).toBe(0.03);
  });

  it('uses unverified motifs only when asked: off by default, switched by setUseUnverifiedMotifs', () => {
    const app = createApp();
    expect(app.useUnverifiedMotifs).toBe(false);
    app.setUseUnverifiedMotifs(true);
    expect(app.useUnverifiedMotifs).toBe(true);
    app.setUseUnverifiedMotifs(false);
    expect(app.useUnverifiedMotifs).toBe(false);
  });

  it('switches the display rate unit without touching the request', () => {
    const app = createApp();
    app.setQuantity({ kind: 'rate', perSecond: 2 });
    app.setRateUnit('min');
    expect(app.rateUnit).toBe('min');
    expect(app.request.quantity).toEqual({ kind: 'rate', perSecond: 2 });
  });
});

describe('target search', () => {
  it('matches English names case-insensitively by substring', () => {
    const app = createApp();
    expect(app.searchTargets('processor').map((i) => i.id)).toContain(PROCESSOR);
    expect(app.searchTargets('  PROCESS ').map((i) => i.id)).toContain(PROCESSOR);
    expect(app.searchTargets('ron ingo').map((i) => i.id)).toEqual([IRON_INGOT]);
  });

  it('lists only items with a producing recipe', () => {
    const app = createApp();
    const ids = app.searchTargets('iron').map((i) => i.id);
    expect(ids).toContain(IRON_INGOT);
    expect(ids).not.toContain(IRON_ORE);
  });

  it('returns nothing for an empty query', () => {
    expect(createApp().searchTargets('')).toEqual([]);
    expect(createApp().searchTargets('   ')).toEqual([]);
  });
});

describe('facility and recipe choices', () => {
  it('lists unlocked buildings of the recipe type, slowest first', () => {
    const app = createApp();
    expect(app.facilityChoices(PROCESSOR_RECIPE).map((b) => b.itemId)).toEqual([2303, 2304, 2305, 2318]);
    expect(app.facilityChoices(IRON_INGOT_RECIPE).map((b) => b.itemId)).toEqual([2302, 2315, 2319]);
  });

  it('lists labs for matrix recipes', () => {
    const app = createApp();
    expect(app.facilityChoices(9).map((b) => b.itemId)).toEqual([2901, 2902]);
  });

  it('drops buildings the selected techs have not unlocked', () => {
    const app = createApp();
    app.setUnlockedTechs([]);
    const ids = app.facilityChoices(PROCESSOR_RECIPE).map((b) => b.itemId);
    expect(ids).not.toContain(RECOMPOSING_ASSEMBLER);
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('recomputes 150 ms after the last mutation, not before', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    await vi.advanceTimersByTimeAsync(149);
    expect(vi.mocked(planProduction)).not.toHaveBeenCalled();
    expect(app.plan).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await app.whenSettled();
    expect(vi.mocked(planProduction)).toHaveBeenCalledTimes(1);
    okPlan(app.plan);
  });

  it('collapses a burst of mutations into one recompute', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    await vi.advanceTimersByTimeAsync(100);
    app.setQuantity({ kind: 'rate', perSecond: 2 });
    await vi.advanceTimersByTimeAsync(100);
    app.toggleSupplied(IRON_INGOT);
    await vi.advanceTimersByTimeAsync(149);
    expect(vi.mocked(planProduction)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await app.whenSettled();
    expect(vi.mocked(planProduction)).toHaveBeenCalledTimes(1);
    const plan = okPlan(app.plan);
    expect(plan.request.suppliedItemIds.has(IRON_INGOT)).toBe(true);
    expect(plan.request.quantity).toEqual({ kind: 'rate', perSecond: 2 });
  });

  it('whenSettled resolves at once when nothing is pending', async () => {
    const app = createApp();
    await expect(app.whenSettled()).resolves.toBeUndefined();
  });

  it('an immediate recompute cancels the pending debounce', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    await app.recompute();
    expect(vi.mocked(planProduction)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(planProduction)).toHaveBeenCalledTimes(1);
  });

  it('whenSettled waits for the pending debounce and the recompute it starts', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    let settled = false;
    void app.whenSettled().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await app.whenSettled();
    expect(settled).toBe(true);
    expect(app.plan).not.toBeNull();
  });
});

describe('stale and failing recomputes', () => {
  it('a slow older recompute does not overwrite a newer result', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);

    const stale: PlanResult = { ok: false, error: { kind: 'infeasible', message: 'stale result' } };
    let release: (r: PlanResult) => void = () => {};
    vi.mocked(planProduction).mockImplementationOnce(
      () => new Promise<PlanResult>((resolve) => (release = resolve)),
    );

    const older = app.recompute();
    app.setQuantity({ kind: 'rate', perSecond: 2 });
    const newer = await app.recompute();
    expect(app.plan).toBe(newer);

    release(stale);
    expect(await older).toBe(stale);
    expect(app.plan).toBe(newer);
    expect(okPlan(app.plan).request.quantity).toEqual({ kind: 'rate', perSecond: 2 });
  });

  it('whenSettled also waits for a recompute that is still running', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    let release: (r: PlanResult) => void = () => {};
    vi.mocked(planProduction).mockImplementationOnce(
      () => new Promise<PlanResult>((resolve) => (release = resolve)),
    );
    void app.recompute();
    let settled = false;
    void app.whenSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release({ ok: false, error: { kind: 'infeasible', message: 'late' } });
    await app.whenSettled();
    expect(settled).toBe(true);
  });

  it('turns a planner exception into an infeasible result instead of rejecting', async () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    vi.mocked(planProduction).mockRejectedValueOnce(new Error('solver exploded'));
    const result = await app.recompute();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('solver exploded');
    expect(app.plan).toBe(result);
  });
});

describe('tech selection', () => {
  it('unlocks everything up to a tech, including its prerequisites', () => {
    const app = createApp();
    app.setUnlockedTechs([]);
    expect(app.techProfileName).toBe('');
    app.unlockUpTo(PROCESSOR_TECH);
    const expected = new Set([...techClosure(data, [PROCESSOR_TECH])].filter((id) => everything.has(id)));
    expect(app.request.unlockedTechs).toEqual(expected);
    expect(app.effects.unlockedRecipes.has(PROCESSOR_RECIPE)).toBe(true);
  });

  it('replaces the selection with exactly the tech and its prerequisites', () => {
    const app = createApp();
    expect(app.request.unlockedTechs).toEqual(everything); // the default "Unlock all" state
    app.unlockUpTo(PROCESSOR_TECH);
    const expected = new Set([...techClosure(data, [PROCESSOR_TECH])].filter((id) => everything.has(id)));
    expect(expected.size).toBeLessThan(everything.size);
    expect(app.request.unlockedTechs).toEqual(expected);
    expect(app.techProfileName).toBe('');
    expect(app.effects.unlockedRecipes.has(PROCESSOR_RECIPE)).toBe(true);
  });

  it('drops techs outside the closure when unlocking up to a tech', () => {
    const app = createApp();
    const outside = [...everything].find((id) => !techClosure(data, [PROCESSOR_TECH]).has(id));
    expect(outside).toBeDefined();
    app.setUnlockedTechs([outside as number]);
    app.unlockUpTo(PROCESSOR_TECH);
    expect(app.request.unlockedTechs.has(outside as number)).toBe(false);
  });

  it('toggles one tech and marks the selection as custom', () => {
    const app = createApp();
    app.toggleTech(PROCESSOR_TECH);
    expect(app.request.unlockedTechs.has(PROCESSOR_TECH)).toBe(false);
    expect(app.techProfileName).toBe('');
    expect(app.effects.unlockedRecipes.has(PROCESSOR_RECIPE)).toBe(false);
    app.toggleTech(PROCESSOR_TECH);
    expect(app.request.unlockedTechs.has(PROCESSOR_TECH)).toBe(true);
  });

  it('ignores tech ids that are not in the game data', () => {
    const app = createApp();
    app.setUnlockedTechs([PROCESSOR_TECH, 99_999_999]);
    expect([...app.request.unlockedTechs]).toEqual([PROCESSOR_TECH]);
  });

  it('unlockAll restores the Unlock all profile', () => {
    const app = createApp();
    app.setUnlockedTechs([]);
    app.unlockAll();
    expect(app.techProfileName).toBe(UNLOCK_ALL_PROFILE);
    expect(app.request.unlockedTechs).toEqual(everything);
  });

  it('moves the final facility to an unlocked one when the selection shrinks', () => {
    const app = createApp();
    app.setTarget(PROCESSOR);
    expect(app.request.finalFacilityItemId).toBe(RECOMPOSING_ASSEMBLER);
    app.setUnlockedTechs(techClosure(data, [PROCESSOR_TECH]));
    expect(app.request.finalFacilityItemId).not.toBe(RECOMPOSING_ASSEMBLER);
    expect(app.facilityChoices(PROCESSOR_RECIPE).map((b) => b.itemId)).toContain(app.request.finalFacilityItemId);
  });
});

describe('final facility', () => {
  it('follows the techs until the user picks one', () => {
    const app = createApp();
    app.setUnlockedTechs([]);
    app.setTarget(PROCESSOR);
    expect(app.request.finalFacilityItemId).not.toBe(RECOMPOSING_ASSEMBLER);
    app.unlockAll();
    expect(app.request.finalFacilityItemId).toBe(RECOMPOSING_ASSEMBLER);

    app.setFinalFacility(2304);
    app.unlockAll();
    expect(app.request.finalFacilityItemId).toBe(2304);
    app.setTarget(1301);
    expect(app.request.finalFacilityItemId).toBe(RECOMPOSING_ASSEMBLER);
  });
});

describe('final facility and the target recipe', () => {
  const ENERGETIC_GRAPHITE = 1109;
  const XRAY_CRACKING = 58;
  const OIL_REFINERY = 2308;
  const NEGENTROPY_SMELTER = 2319;

  it('re-defaults to a facility for the overridden target recipe, so the plan works', async () => {
    const app = createApp();
    app.setTarget(ENERGETIC_GRAPHITE);
    expect(app.request.finalFacilityItemId).toBe(NEGENTROPY_SMELTER);

    app.setRecipeOverride(ENERGETIC_GRAPHITE, XRAY_CRACKING);
    expect(app.request.finalFacilityItemId).toBe(OIL_REFINERY);
    const plan = okPlan(await app.recompute());
    expect(plan.stages.find((s) => s.recipeId === XRAY_CRACKING)?.buildingItemId).toBe(OIL_REFINERY);

    app.setRecipeOverride(ENERGETIC_GRAPHITE, undefined);
    expect(app.request.finalFacilityItemId).toBe(NEGENTROPY_SMELTER);
    okPlan(await app.recompute());
  });

  it('uses the override that was already set when the target changes', () => {
    const app = createApp();
    app.setRecipeOverride(ENERGETIC_GRAPHITE, XRAY_CRACKING);
    app.setTarget(ENERGETIC_GRAPHITE);
    expect(app.request.finalFacilityItemId).toBe(OIL_REFINERY);
  });

  it('keeps a facility the user picked while it still runs the effective recipe', () => {
    const app = createApp();
    app.setTarget(1123); // Graphene: recipes 31 and 32 are both CHEMICAL
    app.setFinalFacility(2309);
    app.setRecipeOverride(1123, 32);
    expect(app.request.finalFacilityItemId).toBe(2309);
  });

  it('drops a picked facility that cannot run the overridden recipe', () => {
    const app = createApp();
    app.setTarget(ENERGETIC_GRAPHITE);
    app.setFinalFacility(2302); // Arc Smelter
    app.setRecipeOverride(ENERGETIC_GRAPHITE, XRAY_CRACKING);
    expect(app.request.finalFacilityItemId).toBe(OIL_REFINERY);
    // The pick is gone, so the default follows the recipe again.
    app.setRecipeOverride(ENERGETIC_GRAPHITE, undefined);
    expect(app.request.finalFacilityItemId).toBe(NEGENTROPY_SMELTER);
  });
});

describe('tech profiles and localStorage', () => {
  it('saves a profile under the versioned key', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const app = createApp();
    app.setUnlockedTechs(techClosure(data, [PROCESSOR_TECH]));
    expect(app.saveProfile('  early game ')).toBe(true);
    expect(app.techProfileName).toBe('early game');
    expect(Object.keys(app.profiles)).toEqual(['early game']);

    expect(PROFILES_KEY).toBe('dsp-planner.techProfiles.v1');
    const stored = JSON.parse(storage.map.get(PROFILES_KEY) ?? 'null') as Record<string, number[]>;
    expect(new Set(stored['early game'])).toEqual(app.request.unlockedTechs);
  });

  it('restores the last used profile in a new session', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const first = createApp();
    first.setUnlockedTechs(techClosure(data, [PROCESSOR_TECH]));
    first.saveProfile('early game');

    const second = createApp();
    expect(second.techProfileName).toBe('early game');
    expect(second.request.unlockedTechs).toEqual(first.request.unlockedTechs);
    expect(second.effects.unlockedRecipes.has(PROCESSOR_RECIPE)).toBe(true);
  });

  it('starts on Unlock all when profiles exist but none was last used', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [PROFILES_KEY]: JSON.stringify({ small: [PROCESSOR_TECH] }) }));
    const app = createApp();
    expect(app.techProfileName).toBe(UNLOCK_ALL_PROFILE);
    expect(Object.keys(app.profiles)).toEqual(['small']);
  });

  it('selects a saved profile and the built-in one', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [PROFILES_KEY]: JSON.stringify({ small: [PROCESSOR_TECH] }) }));
    const app = createApp();
    app.selectProfile('small');
    expect(app.techProfileName).toBe('small');
    expect([...app.request.unlockedTechs]).toEqual([PROCESSOR_TECH]);
    app.selectProfile('does not exist');
    expect(app.techProfileName).toBe('small');
    app.selectProfile(UNLOCK_ALL_PROFILE);
    expect(app.request.unlockedTechs).toEqual(everything);
  });

  it('filters restored tech ids against the game data before computing effects', () => {
    const stored = { stale: [PROCESSOR_TECH, 99_999_999, -1, 'x', null] };
    vi.stubGlobal(
      'localStorage',
      memoryStorage({ [PROFILES_KEY]: JSON.stringify(stored), 'dsp-planner.activeProfile.v1': 'stale' }),
    );
    const app = createApp();
    expect(app.techProfileName).toBe('stale');
    expect([...app.request.unlockedTechs]).toEqual([PROCESSOR_TECH]);
    expect(app.profiles.stale).toEqual([PROCESSOR_TECH]);
    expect(app.effects.unlockedRecipes.has(PROCESSOR_RECIPE)).toBe(true);
  });

  it('ignores malformed stored profiles', () => {
    for (const bad of ['not json', '[1,2]', '"x"', 'null', '{"a":5}']) {
      vi.stubGlobal('localStorage', memoryStorage({ [PROFILES_KEY]: bad }));
      const app = createApp();
      expect(app.techProfileName).toBe(UNLOCK_ALL_PROFILE);
      expect(app.profiles).toEqual({});
    }
  });

  it('deletes a saved profile, keeps the selection and forgets it on disk', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const app = createApp();
    app.setUnlockedTechs([PROCESSOR_TECH]);
    app.saveProfile('gone');
    app.deleteProfile('gone');
    expect(app.profiles).toEqual({});
    expect(app.techProfileName).toBe('');
    expect([...app.request.unlockedTechs]).toEqual([PROCESSOR_TECH]);
    expect(JSON.parse(storage.map.get(PROFILES_KEY) ?? 'null')).toEqual({});
    expect(createApp().techProfileName).toBe(UNLOCK_ALL_PROFILE);
  });

  it('rejects empty and reserved profile names', () => {
    const app = createApp();
    expect(app.saveProfile('   ')).toBe(false);
    expect(app.saveProfile(UNLOCK_ALL_PROFILE)).toBe(false);
    expect(app.profiles).toEqual({});
  });

  it('keeps working when localStorage throws on every access', () => {
    vi.stubGlobal('localStorage', memoryStorage({}, new Error('SecurityError')));
    const app = createApp();
    expect(app.techProfileName).toBe(UNLOCK_ALL_PROFILE);
    app.setUnlockedTechs([PROCESSOR_TECH]);
    expect(app.saveProfile('mine')).toBe(true);
    expect(app.profiles.mine).toEqual([PROCESSOR_TECH]);
    app.deleteProfile('mine');
    expect(app.profiles).toEqual({});
  });

  it('keeps working when there is no localStorage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    const app = createApp();
    expect(app.saveProfile('mine')).toBe(true);
    expect(app.techProfileName).toBe('mine');
  });
});

// -- the layout solve ---------------------------------------------------------------------

type StartSolve = NonNullable<AppDeps['startSolve']>;

/** A solver whose runs the test finishes by hand. */
function fakeSolver() {
  const runs: {
    plan: Parameters<StartSolve>[0];
    opts: Parameters<StartSolve>[3];
    callbacks: NonNullable<Parameters<StartSolve>[4]>;
    stop: ReturnType<typeof vi.fn>;
    finish(result: SolveResult): void;
    fail(error: Error): void;
  }[] = [];
  const startSolve: StartSolve = (plan, _index, _effects, opts, callbacks = {}) => {
    let finish!: (result: SolveResult) => void;
    let fail!: (error: Error) => void;
    const done = new Promise<SolveResult>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const stop = vi.fn();
    runs.push({ plan, opts, callbacks, stop, finish, fail });
    return { stop, done };
  };
  return { runs, startSolve };
}

const solved = compositeLayout().kit.layout();
const passing = { pass: true, violations: [], checkedAt: '2026-01-01T00:00:00Z', stage: 'simulation' as const };

function resultOf(over: Partial<SolveResult> = {}): SolveResult {
  return {
    layout: solved,
    report: passing,
    footprint: 120,
    attempts: 5,
    validated: 3,
    stoppedBy: 'budget',
    failures: [],
    ...over,
  };
}

/** An app with the Iron Ingot planned and a fake solver behind it. */
async function solvingApp() {
  const solver = fakeSolver();
  const app = createApp({ startSolve: solver.startSolve });
  app.setTarget(IRON_INGOT);
  await app.whenSettled();
  return { app, ...solver };
}

describe('solve', () => {
  it('can only start on an ok, settled plan', async () => {
    const solver = fakeSolver();
    const app = createApp({ startSolve: solver.startSolve });
    expect(app.canSolve).toBe(false);
    app.startSolve();
    expect(solver.runs).toHaveLength(0);
    expect(app.solve.status).toBe('idle');

    app.setTarget(IRON_INGOT);
    expect(app.canSolve).toBe(false); // the plan is still being computed
    await app.whenSettled();
    expect(app.canSolve).toBe(true);
    app.toggleSupplied(IRON_ORE); // iron ore is no longer supplied and nothing makes it: no plan
    await app.whenSettled();
    expect(app.canSolve).toBe(false);
  });

  it('hands the worker the plan, the effects and the budget in milliseconds, and runs until it answers', async () => {
    const { app, runs } = await solvingApp();
    app.setSolverBudgetMinutes(0.5);
    app.startSolve();
    expect(app.solve.status).toBe('running');
    expect(runs).toHaveLength(1);
    expect(runs[0].plan).toBe(okPlan(app.plan));
    expect(runs[0].opts.timeBudgetMs).toBe(30_000);
    expect(runs[0].opts.ladderBudgetMs).toBe(30_000); // the fallback ladder is bound by the budget too: a plan the router cannot do must not hang the app
    expect(runs[0].opts.simulate).toBe(true);
    expect(app.solve.budgetMs).toBe(30_000);
    expect(app.solve.layout).toBeNull();
    expect(app.blueprint).toBeNull();

    runs[0].callbacks.onProgress?.({ elapsedMs: 1000, attempts: 2, validated: 1, bestFootprint: null, phase: 'ladder' });
    expect(app.solve.progress?.attempts).toBe(2);
    runs[0].callbacks.onImproved?.(solved, passing, 150);
    expect(app.solve.layout).toBe(solved);
    expect(app.solve.footprint).toBe(150);
    expect(app.solve.status).toBe('running');

    runs[0].finish(resultOf({ footprint: 120 }));
    await app.whenSolved();
    expect(app.solve.status).toBe('done');
    expect(app.solve.footprint).toBe(120);
    expect(app.solve.report).toBe(passing);
    expect(app.solve.result?.stoppedBy).toBe('budget');
  });

  it('hands the worker the motif option as it stands when the solve starts', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    expect(runs[0].opts.useUnverifiedMotifs).toBe(false);
    app.setUseUnverifiedMotifs(true);
    app.startSolve();
    expect(runs[1].opts.useUnverifiedMotifs).toBe(true);
    expect(runs[0].opts.useUnverifiedMotifs).toBe(false); // the run in flight keeps what it was given
  });

  it('uses a new seed for each run', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    app.startSolve();
    expect(runs[1].opts.seed).not.toBe(runs[0].opts.seed);
  });

  it('builds the blueprint from the best layout: titled with the target and rate, flagged as approximate', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    runs[0].callbacks.onImproved?.(solved, passing, 150);
    const bp = app.blueprint!;
    expect(bp.error).toBeNull();
    expect(bp.text.startsWith('BLUEPRINT:')).toBe(true);
    expect(bp.shortDesc).toBe('Iron Ingot 1/s');
    expect(bp.fileName).toBe('iron-ingot-1.txt');
    expect(bp.desc).toContain('Iron Ingot 1/s');
    expect(bp.desc).toContain('Iron Ore');
    // Review Focus #5: the layout is on approximate geometry, so the UI is told and the string carries the flag.
    expect(solved.meta.geometrySource).toBe('approximate');
    expect(bp.approximate).toBe(true);
    const header = decodeBlueprint(bp.text).header;
    expect(header.shortDesc).toBe('Iron Ingot 1/s');
    expect(header.desc).toContain('approximate');
    // The same layout gives the same object: reading it again does not rebuild the string.
    expect(app.blueprint).toBe(bp);
  });

  it('describes the blueprint with the stations and the power of the layout, not the plan\'s lower bound', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    const plan = okPlan(app.plan);
    expect(plan.stationsNeeded).toBe(1);
    // two Interstellar stations (60 MW each) where the plan counted one Planetary one (12 MW)
    const pair = stationPairLayout();
    for (const b of pair.kit.buildings) if (b.station) b.station.chargePerTick = 1_000_000;
    runs[0].callbacks.onImproved?.(pair.kit.layout(), passing, 150);
    const desc = app.blueprint!.desc;
    expect(app.blueprint!.error).toBeNull();
    expect(desc).toContain(', 2 stations, 150 tiles.');
    // no simulation in the report, so the power line is an estimate, and it has the layout's 120 MW of station charge
    expect(desc).toContain(`Power (estimate): ${formatPower(plan.power.steadyW + 0.1 * 108e6)} steady, ${formatPower(plan.power.peakW + 108e6)} peak.`);
  });

  it('does not flag extracted geometry as approximate', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    const extracted = { ...solved, meta: { ...solved.meta, geometrySource: 'extracted' as const } };
    runs[0].callbacks.onImproved?.(extracted, passing, 150);
    expect(app.blueprint?.approximate).toBe(false);
    const desc = decodeBlueprint(app.blueprint!.text).header.desc;
    expect(desc).not.toContain('approximate');
    // ...but the conventions are unverified until a paste in game says otherwise, whatever the geometry (final review, M5)
    expect(desc).toContain('[conventions: yaw and axes not yet verified in game]');
  });

  it('reports a layout the blueprint builder rejects instead of throwing', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    const broken = { ...solved, belts: [{ ...solved.belts[0], tierItemId: 9999 as 2001 }] };
    runs[0].callbacks.onImproved?.(broken, passing, 150);
    expect(app.blueprint?.text).toBe('');
    expect(app.blueprint?.error).toMatch(/could not be built/);
  });

  it('stops a running solve when a new one starts and ignores the old one\'s late answer', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    runs[0].callbacks.onImproved?.(solved, passing, 150);
    app.startSolve();
    expect(runs[0].stop).toHaveBeenCalledOnce();
    expect(runs).toHaveLength(2);
    expect(app.solve.layout).toBeNull(); // the new run starts empty

    runs[0].callbacks.onImproved?.(solved, passing, 99);
    runs[0].callbacks.onProgress?.({ elapsedMs: 5, attempts: 99, validated: 99, bestFootprint: 99, phase: 'old' });
    runs[0].finish(resultOf({ footprint: 99 }));
    await Promise.resolve();
    expect(app.solve.layout).toBeNull();
    expect(app.solve.progress).toBeNull();
    expect(app.solve.status).toBe('running');

    runs[1].finish(resultOf({ footprint: 77 }));
    await app.whenSolved();
    expect(app.solve.footprint).toBe(77);
  });

  it('stop asks the worker once and keeps running until it answers with its best', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    runs[0].callbacks.onImproved?.(solved, passing, 150);
    app.stopSolve();
    app.stopSolve();
    expect(runs[0].stop).toHaveBeenCalledOnce();
    expect(app.solve.stopping).toBe(true);
    expect(app.solve.status).toBe('running');
    runs[0].finish(resultOf({ stoppedBy: 'user', footprint: 150 }));
    await app.whenSolved();
    expect(app.solve.status).toBe('done');
    expect(app.solve.stopping).toBe(false);
    expect(app.solve.result?.stoppedBy).toBe('user');
    expect(app.solve.layout).toBe(solved);
  });

  it('stop does nothing when no solve is running', async () => {
    const { app, runs } = await solvingApp();
    app.stopSolve();
    expect(app.solve.stopping).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it('marks the result stale when the plan changes, without cancelling or clearing it', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    expect(app.solve.stale).toBe(false);
    runs[0].callbacks.onImproved?.(solved, passing, 150);

    app.setQuantity({ kind: 'rate', perSecond: 2 });
    await app.whenSettled();
    expect(app.solve.stale).toBe(true);
    expect(app.solve.status).toBe('running');
    expect(runs[0].stop).not.toHaveBeenCalled();
    expect(app.solve.layout).toBe(solved);

    runs[0].finish(resultOf());
    await app.whenSolved();
    expect(app.solve.status).toBe('done');
    expect(app.solve.stale).toBe(true);

    // A plan that comes out the same is not a change; going back clears the banner.
    app.setQuantity({ kind: 'rate', perSecond: 1 });
    await app.whenSettled();
    expect(app.solve.stale).toBe(false);

    app.setQuantity({ kind: 'rate', perSecond: 3 });
    await app.whenSettled();
    expect(app.solve.stale).toBe(true);
    app.startSolve();
    expect(app.solve.stale).toBe(false);
    expect(runs[1].plan).toBe(okPlan(app.plan));
  });

  it('is stale when the plan stops being feasible', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    runs[0].finish(resultOf());
    await app.whenSolved();
    app.toggleSupplied(IRON_ORE);
    await app.whenSettled();
    expect(app.plan?.ok).toBe(false);
    expect(app.solve.stale).toBe(true);
  });

  it('is not stale before any solve', async () => {
    const { app } = await solvingApp();
    expect(app.solve.stale).toBe(false);
  });

  it('keeps the failures when the ladder finds nothing', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    runs[0].finish(resultOf({ layout: null, report: null, footprint: null, stoppedBy: 'exhausted', failures: ['BELT_OVERLAP: x'] }));
    await app.whenSolved();
    expect(app.solve.status).toBe('done');
    expect(app.solve.layout).toBeNull();
    expect(app.blueprint).toBeNull();
    expect(app.solve.result?.failures).toEqual(['BELT_OVERLAP: x']);
  });

  it('reports a worker that fails, and keeps the best layout it had sent', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    runs[0].callbacks.onImproved?.(solved, passing, 150);
    runs[0].fail(new Error('the solver worker failed'));
    await app.whenSolved();
    expect(app.solve.status).toBe('error');
    expect(app.solve.error).toBe('the solver worker failed');
    expect(app.solve.layout).toBe(solved);
  });

  it('reports a worker that cannot be created', async () => {
    const app = createApp({
      startSolve: () => {
        throw new ReferenceError('Worker is not defined');
      },
    });
    app.setTarget(IRON_INGOT);
    await app.whenSettled();
    app.startSolve();
    expect(app.solve.status).toBe('error');
    expect(app.solve.error).toContain('Worker is not defined');
    await app.whenSolved();
    // A later solve can still run.
    expect(app.canSolve).toBe(true);
  });

  it('forgets the picked violation when a new report replaces the old one, but not when the final answer repeats it', async () => {
    const { app, runs } = await solvingApp();
    const violation: Violation = { code: 'BELT_OVERLAP', entities: [{ kind: 'belt', id: 1 }], message: 'm' };
    app.startSolve();
    runs[0].callbacks.onImproved?.(solved, passing, 150);
    app.selectViolation(violation);
    runs[0].callbacks.onImproved?.(solved, { ...passing }, 120);
    expect(app.selectedViolation).toBeNull();

    // The worker's answer carries its best again, as a copy: the same layout, so the pick stays.
    app.selectViolation(violation);
    const copy = { ...solved };
    runs[0].finish(resultOf({ layout: copy, report: { ...passing }, footprint: 120 }));
    await app.whenSolved();
    expect(app.selectedViolation).toBe(violation);
    expect(app.solve.layout).not.toBe(copy);
  });

  it('takes the final answer when it is a better layout than the last one reported', async () => {
    const { app, runs } = await solvingApp();
    app.startSolve();
    runs[0].callbacks.onImproved?.(solved, passing, 150);
    const better = { ...solved };
    runs[0].finish(resultOf({ layout: better, footprint: 100 }));
    await app.whenSolved();
    expect(app.solve.layout).toBe(better);
    expect(app.solve.footprint).toBe(100);
  });

  it('forgets the picked violation when a new solve starts', async () => {
    const { app } = await solvingApp();
    const violation: Violation = { code: 'BELT_OVERLAP', entities: [{ kind: 'belt', id: 1 }], message: 'm' };
    app.selectViolation(violation);
    expect(app.selectedViolation).toBe(violation);
    app.startSolve();
    expect(app.selectedViolation).toBeNull();
  });
});

describe('blueprintFileName', () => {
  it('is <target-name>-<rate>.txt in lower case with dashes', () => {
    expect(blueprintFileName('Circuit Board', 1)).toBe('circuit-board-1.txt');
    expect(blueprintFileName('Re-composing Assembler', 1.5)).toBe('re-composing-assembler-1.5.txt');
    expect(blueprintFileName('Processor', 0.333333)).toBe('processor-0.333.txt');
    expect(blueprintFileName('???', 2)).toBe('blueprint-2.txt');
  });
});

describe('makeBlueprint: the surplus exports of the layout', () => {
  it('names the items whose belts end at an export slot for a surplus, so the player drains them; a layout without says nothing', async () => {
    const app = createAppState(data);
    app.setTarget(IRON_INGOT);
    await app.whenSettled();
    const plan = { ...okPlan(app.plan), surplus: [{ itemId: IRON_INGOT, perSecond: 0.5 }] }; // a candidate
    const index = new GameDataIndex(data);
    const pair = stationPairLayout();
    const without = makeBlueprint(pair.kit.layout(), plan, index, 100, null);
    expect(without.desc).not.toContain('Surplus export');
    pair.sink.station!.slots[0].itemId = IRON_INGOT; // the layout has an export slot for the candidate
    const withSink = makeBlueprint(pair.kit.layout(), plan, index, 100, null);
    expect(withSink.desc).toContain('Surplus export (drain it in game): Iron Ingot.');
    // a station that holds the item as a plain slot of a plan without candidates is no surplus export
    expect(makeBlueprint(pair.kit.layout(), okPlan(app.plan), index, 100, null).desc).not.toContain('Surplus export');
  });
});

describe('makeBlueprint: a plan that makes the proliferator it sprays with (final review, item 1)', () => {
  const MK3 = 1143;
  async function selfSprayedApp(): Promise<AppState> {
    const app = createAppState(data);
    app.setTarget(MK3);
    app.setProliferator({ tier: 3, mode: 'extra' });
    await app.whenSettled();
    return app;
  }

  it('lists no supply of it and says where it comes from, with the spray and the stages\' gross rate', async () => {
    const app = await selfSprayedApp();
    const plan = okPlan(app.plan);
    expect(plan.selfSpray?.itemId).toBe(MK3);
    const made = makeBlueprint(stationPairLayout().kit.layout(), plan, new GameDataIndex(data), 100, null);
    expect(made.desc).not.toMatch(/Supplied:[^.]*Proliferator Mk\.III/);
    expect(made.desc).toContain("of the Proliferator Mk.III the stages make feeds the plan's own spray coaters");
    expect(made.desc).toContain('put a few Proliferator Mk.III in it first');
    const spray = plan.selfSpray!.perSecond;
    expect(made.desc).toContain(`${formatCount(spray)}/s of the Proliferator Mk.III`);
    expect(made.desc).toContain(`to deliver ${formatCount(plan.exports[0].perSecond)}/s`);
  });

  it('a plan whose proliferator is supplied says nothing of it', async () => {
    const app = createAppState(data);
    app.setTarget(PROCESSOR);
    app.setProliferator({ tier: 3, mode: 'extra' });
    await app.whenSettled();
    const plan = okPlan(app.plan);
    expect(plan.selfSpray).toBeUndefined();
    const made = makeBlueprint(stationPairLayout().kit.layout(), plan, new GameDataIndex(data), 100, null);
    expect(made.desc).not.toContain('spray coaters, so');
    expect(made.desc).toMatch(/Supplied:.*Proliferator Mk\.III/);
  });
});
