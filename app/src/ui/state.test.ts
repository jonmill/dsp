import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFixtureGameData } from '../../test/fixtures/fixtureGameData';
import { planProduction } from '../lib/calc';
import type { PlanResult, ProductionPlan } from '../lib/calc';
import { allTechs, techClosure } from '../lib/data';
import { createAppState, PROFILES_KEY, UNLOCK_ALL_PROFILE } from './state.svelte';
import type { AppState } from './state.svelte';

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

function createApp(): AppState {
  const app = createAppState(data);
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
