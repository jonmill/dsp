// Runs a Layout through the tick simulator: builds the `World` (belts, stations), puts a machine in every production
// building and lab, a sorter in every layout sorter and a coater in every layout coater, warms the block up and
// measures it. Nothing here judges the result; `validate/report.ts` turns a `SimResult` into violations.
//
// Progress, for deadlock detection (a ruling of the Task 17/19 reviews): a tick made progress if a station input
// port took an item, a machine advanced a craft, or a sorter delivered an item. Cargo circulating in a merge cycle is
// none of these, so a loop of belts never hides a stuck block.
//
// Power: sorters, machines and coaters report their demand to the world every tick and set next tick's serve ratio
// (`World`). Station charging is not part of that loop: it is reported as a constant at peak (blocks start with empty
// stations), and `steadyW` leaves it out.
import type { ProductionPlan, ItemRate } from '../../calc';
import type { Building, GameDataIndex, Recipe, TechEffects } from '../../data';
import { coaterBuilding, coaterProliferators, findCoaterTop, sprayCoaterDef } from '../../geometry';
import type { Endpoint, Layout, PlacedBuilding, Sorter } from '../../geometry';
import { CoaterSim, coaterConfig } from './coater';
import { LabStack } from './labstack';
import { MachineSim, machineConfig } from './machine';
import { SorterSim, sorterSettings } from './sorter';
import type { BeltRef } from './sorter';
import { World } from './world';
import type { SimEntity } from './world';

export interface SimOptions {
  /**
   * Ticks to run before measuring, used exactly. Omitted: adaptive. The warm-up then runs in windows of 3600 ticks and
   * stops only after two consecutive windows that both reach 99.9 % of the provisioned rate (so at least two windows,
   * and one window that overshoots while the block is still filling does not end it), and never after
   * `MAX_WARMUP_TICKS` (20 game minutes). A block that settles below the provisioned rate runs to the cap: a plateau is
   * no proof of a steady state (a long chain fills in steps), and the measurement then judges it. `SimResult.warmupTicksUsed`
   * says how long it ran.
   */
  warmupTicks?: number;
  /** Ticks measured. Default 18000 (5 game minutes). */
  measureTicks?: number;
  /** Power the block's network can supply, in watts. Omitted: unlimited (serve ratio 1). */
  powerSupplyW?: number;
  /**
   * Asked every `ABORT_CHECK_TICKS` ticks, in the warm-up and the measurement; when it says yes the run ends with a
   * `SimulationAborted`. For a caller that has run out of time (the solver's budget): a long simulation need not be
   * waited for.
   */
  shouldAbort?: () => boolean;
  /**
   * The adaptive warm-up gives up once it has run this many ticks (counted in whole windows of 3600; a cap of
   * `MAX_WARMUP_TICKS` or more is no cap) if the target has not reached its rate by then: the run ends with a
   * `WarmupNotSettled` and nothing is measured. A run
   * that does settle before the cap warms up for exactly as long as it would without it and measures the same, so a
   * layout it passes is one that the run without the cap passes too. The warm-up that `acceptable` asks for never goes
   * beyond a cap below `MAX_WARMUP_TICKS` either; at `MAX_WARMUP_TICKS` or more it is limited by `MAX_FILL_WARMUP_TICKS`
   * alone. Ignored when `warmupTicks` is given.
   */
  warmupCapTicks?: number;
  /**
   * Whether a result needs no more waiting (for `validateLayout`: that it passes). Asked once, after the measurement that
   * follows the adaptive warm-up. When it says no and the block is still filling, the run warms up on (no verdict in between)
   * until it is not or `MAX_FILL_WARMUP_TICKS` (or a `warmupCapTicks` below `MAX_WARMUP_TICKS`, if less) is reached, and then measures again as it did
   * the first time: that measurement is the result. A block is still filling if the total of what its belts and machines
   * hold grew in each of the last two windows of 36000 ticks by more than its jitter allows (see `stillFilling`). Omitted: the
   * first measurement stands. Ignored when `warmupTicks` is given.
   */
  acceptable?: (result: SimResult) => boolean;
}

/** `SimOptions.shouldAbort` said yes. */
export class SimulationAborted extends Error {
  constructor() {
    super('the simulation was aborted');
    this.name = 'SimulationAborted';
  }
}

/** The adaptive warm-up reached `SimOptions.warmupCapTicks` with the target short of its rate. */
export class WarmupNotSettled extends Error {
  constructor(readonly ticks: number) {
    super(`the target had not reached its rate after ${ticks} warm-up ticks`);
    this.name = 'WarmupNotSettled';
  }
}

export interface MachineStat {
  buildingId: number;
  /** Index into `plan.stages` this machine counts for, or null if it matches no stage. */
  stageIndex: number | null;
  /** Crafts finished in the measurement window. */
  crafts: number;
  /** Share of the window the machine was replicating. */
  busyFraction: number;
  /** Share of the window a finished craft waited for room in the output buffer. */
  outputBlockedFraction: number;
  /** Share of the window the machine lacked ingredients to start. */
  starvedFraction: number;
}

export interface StageStat {
  stageIndex: number;
  /** Crafts finished by all the stage's machines in the measurement window. */
  crafts: number;
  /** `stage.craftsPerSecond` times the window, in seconds. */
  plannedCrafts: number;
}

export interface SimResult {
  /** Items per second of the plan's target item that reached a station input port in the window. */
  measuredTargetRate: number;
  /** One entry per `plan.exports` entry, in order. */
  measuredExports: ItemRate[];
  machineStats: MachineStat[];
  stageStats: StageStat[];
  /** No progress for 600 consecutive measured ticks while the plan expects output. */
  deadlocked: boolean;
  /** Measured average draw; the peak adds the stations' charge. All in watts. */
  power: {
    /** Average demand of machines, sorters and coaters over the window, station charge excluded. */
    steadyW: number;
    /** The idle share of `steadyW`. */
    idleW: number;
    /** The highest single-tick demand of machines, sorters and coaters, plus `stationChargeW`. */
    peakW: number;
    /** The sum of the stations' `chargePerTick`, drawn in full while the stations are empty. */
    stationChargeW: number;
  };
  /** What the spray coaters did in the measurement window: zeros for a layout without any. */
  coaters: {
    /** Coaters in the layout that have a proliferator belt over their top passage and so can spray. */
    count: number;
    /** Items sprayed in the window (the stacks of the cargo summed). */
    sprayedItems: number;
    /** Proliferator items per second the coaters took from the proliferator belts. */
    proliferatorPerSecond: number;
  };
  /** The length of the measurement window, in seconds. */
  measureSeconds: number;
  /** The ticks run before the window: `SimOptions.warmupTicks` as given, else what the adaptive warm-up needed. */
  warmupTicksUsed: number;
  /** Things the simulator saw in the layout that make it act differently from what was meant (mis-wired ports...). */
  warnings: string[];
}

/** The adaptive warm-up runs in windows of this many ticks (1 game minute), at least two of them. */
const WARMUP_WINDOW_TICKS = 3600;
/**
 * The adaptive warm-up never runs longer than this many ticks (20 game minutes), whether or not the target reached its
 * rate by then; the measurement that follows judges a block that is still short.
 */
export const MAX_WARMUP_TICKS = 72000;
/**
 * The longest a run with `SimOptions.acceptable` warms up (1250 game minutes, 21 hours), whatever is still filling. A producer
 * with slack fills the belt of its product at its surplus, and a stage that shares a scarce input with it runs short meanwhile:
 * a proliferated High-Explosive Shell Set sized to 98 % of its Refined Oil starves the Plastic stage for 80 game minutes while the
 * Sulfuric Acid belt (232 cargo, 0.06 cargo/s of surplus) fills, and then reads 103 %; the first 20 game minutes read 95 % of a
 * layout that is right.
 */
export const MAX_FILL_WARMUP_TICKS = 4_500_000;
/** The total of what the belts and machines hold is sampled this often (10 game seconds), by a run with `acceptable`. */
const STORED_SAMPLE_TICKS = 600;
/**
 * The windows `stillFilling` compares are this long (10, 40 and 160 game minutes), or half of what the run has been so far if
 * that is less: a fill that is slow beside the jitter of the total shows in a longer window, in which the jitter, that does not
 * grow with the length, is smaller beside the growth, that does.
 */
const FILL_WINDOW_TICKS = [36000, 144000, 576000] as const;
/** A run with `acceptable` that waits for a start-up to end looks again after this many ticks (10 game minutes). */
const FILL_STEP_TICKS = 36000;
/** A window counts as having filled if the total grew by more than this many times the jitter of the total (what a straight line fitted to the window leaves over)... */
const FILL_SIGMAS = 1.5;
/** ...and by at least this much (cargo and items): the smallest plans swing by 5, a fill of fewer than 10 in 10 game minutes is none that matters. */
const FILL_MIN = 10;
/** `SimOptions.shouldAbort` is asked this often (10 game seconds). */
export const ABORT_CHECK_TICKS = 600;
/** Two consecutive warm-up windows that each make this share of the provisioned rate end the adaptive warm-up. */
const WARMUP_REACHED = 0.999;
const DEFAULT_MEASURE_TICKS = 18000;
/** Consecutive measured ticks without progress that make a deadlock. */
export const DEADLOCK_TICKS = 600;
const STAGE_ROLE = /^stage:(\d+)$/;
const itemName = (data: GameDataIndex, itemId: number): string => {
  try {
    return data.item(itemId).name;
  } catch {
    return `item ${itemId}`;
  }
};

const recipeOrNull = (data: GameDataIndex, recipeId: number): Recipe | null => {
  try {
    return data.recipe(recipeId);
  } catch {
    return null;
  }
};

const buildingName = (data: GameDataIndex, b: PlacedBuilding): string => data.building(b.itemId)?.name ?? `item ${b.itemId}`;

/**
 * The target rate the plan provisions: its export of the target item, which is what the user asked for. Not
 * `actualTargetRate`, which is the rounded-up capacity of the final stage and can exceed it when an upstream stage
 * limits the chain (Gear at 1/s on two Mk.I assemblers has capacity 1.5/s but one Arc Smelter feeds only 1/s).
 * Falls back to the requested rate, or to the capacity when the request is in buildings and exports are missing.
 */
export function provisionedRate(plan: ProductionPlan): number {
  const exported = plan.exports.find((e) => e.itemId === plan.request.targetItemId)?.perSecond;
  if (exported !== undefined) return exported;
  return plan.request.quantity.kind === 'rate' ? plan.request.quantity.perSecond : plan.actualTargetRate;
}

/**
 * Simulate `layout` for a warm-up (`opts.warmupTicks`, else adaptive: see `SimOptions`) and `measureTicks` more ticks,
 * and report what the measurement window saw. Throws for a layout the simulator cannot even build (a sorter or belt
 * end that names a missing building or belt, a belt tier that is not a belt, a window that is not a positive whole
 * number of ticks); the geometry checks catch those first.
 */
export function runSimulation(
  layout: Layout,
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  opts: SimOptions = {},
): SimResult {
  const measureTicks = opts.measureTicks ?? DEFAULT_MEASURE_TICKS;
  if (opts.warmupTicks !== undefined && (!Number.isInteger(opts.warmupTicks) || opts.warmupTicks < 0)) {
    throw new RangeError(`warmupTicks ${opts.warmupTicks} must be a whole number of at least 0`);
  }
  if (!Number.isInteger(measureTicks) || measureTicks < 1) throw new RangeError(`measureTicks ${measureTicks} must be a whole number of at least 1`);
  const tps = data.data.constants.ticksPerSecond;
  const measureSeconds = measureTicks / tps;

  const world = new World(layout, plan, data, effects, { powerSupplyW: opts.powerSupplyW });
  const buildingById = new Map<number, PlacedBuilding>();
  for (const b of layout.buildings) buildingById.set(b.id, b);
  const warnings = stationWarnings(layout, data, buildingById);

  const meter = new PowerMeter(world);
  const progress = { count: 0 };

  const machines = addMachines(world, layout, plan, data, meter, progress, warnings);
  addLabStacks(world, layout, machines.byBuilding, warnings);
  addSorters(world, layout, data, effects, buildingById, machines.byBuilding, meter, progress, warnings);
  const coaters = addCoaters(world, layout, data, meter, warnings);

  const stationItems = layout.buildings.flatMap((b) =>
    b.station ? [{ station: world.station(b.id), items: b.station.slots.map((s) => s.itemId).filter((id) => id !== 0) }] : [],
  );
  const received = (itemId: number): number => {
    let sum = 0;
    for (const s of stationItems) sum += s.station.received(itemId);
    return sum;
  };
  const receivedAny = (): number => {
    let sum = 0;
    for (const s of stationItems) for (const id of s.items) sum += s.station.received(id);
    return sum;
  };

  const expectsOutput = plan.actualTargetRate > 0;
  let measuring = false;
  let lastSignature = 0;
  let streak = 0;
  let longestStreak = 0;
  let peakTick = 0;
  let sumTick = 0;
  let sumIdleTick = 0;
  // Last in the last phase: runs once every other entity has acted this tick.
  world.addEntity(
    {
      tick() {
        const demand = meter.total;
        if (demand > peakTick) peakTick = demand;
        const signature = progress.count + receivedAny();
        if (measuring) {
          sumTick += demand;
          sumIdleTick += meter.idle;
          streak = signature === lastSignature ? streak + 1 : 0;
          if (streak > longestStreak) longestStreak = streak;
        }
        lastSignature = signature;
        meter.endTick();
      },
    },
    'stationOut',
  );

  const exportItems = plan.exports.map((e) => e.itemId);
  const targetItem = plan.request.targetItemId;

  const shouldAbort = opts.shouldAbort;
  // A run that may warm up longer follows what the belts and machines hold: the total at the end of every sample.
  const beltSims = [...world.belts.values()];
  const storedNow = (): number => {
    let sum = 0;
    for (const b of beltSims) sum += b.cargoCount();
    for (const m of machines.list) sum += m.machine.stored();
    return sum;
  };
  const stored: number[] | undefined = opts.acceptable && opts.warmupTicks === undefined ? [] : undefined;
  /** `n` ticks, asking `shouldAbort` now and then. */
  const runTicks = (n: number): void => {
    for (let t = 0; t < n; t++) {
      if (shouldAbort && t % ABORT_CHECK_TICKS === 0 && shouldAbort()) throw new SimulationAborted();
      world.tick();
      if (stored && world.ticks % STORED_SAMPLE_TICKS === 0) stored.push(storedNow());
    }
  };

  let warmupTicksUsed = 0;
  if (opts.warmupTicks !== undefined) {
    runTicks(opts.warmupTicks);
    warmupTicksUsed = opts.warmupTicks;
  } else {
    // Adaptive: windows of the target's rate until two in a row reach the provisioned rate, at most MAX_WARMUP_TICKS.
    // Two windows that merely agree do not end it: a deep chain fills in steps, with plateaus between them.
    const wanted = provisionedRate(plan);
    const reached = (rate: number): boolean => wanted > 0 && rate >= WARMUP_REACHED * wanted;
    const cap = Math.min(MAX_WARMUP_TICKS, opts.warmupCapTicks ?? MAX_WARMUP_TICKS);
    let previous = 0;
    let settled = false;
    while (warmupTicksUsed < cap) {
      const before = received(targetItem);
      runTicks(WARMUP_WINDOW_TICKS);
      warmupTicksUsed += WARMUP_WINDOW_TICKS;
      const windowRate = (received(targetItem) - before) / (WARMUP_WINDOW_TICKS / tps);
      if (reached(previous) && reached(windowRate)) {
        settled = true;
        break;
      }
      previous = windowRate;
    }
    if (!settled && opts.warmupCapTicks !== undefined && opts.warmupCapTicks < MAX_WARMUP_TICKS) throw new WarmupNotSettled(warmupTicksUsed);
  }
  /** Measure `measureTicks` more ticks: the counters start from zero, the block from the state it is in. */
  const measure = (): SimResult => {
    for (const m of machines.list) m.machine.resetStats();
    const coatersAtStart = coaters.map((c) => ({ sprayed: c.sprayedItems, taken: c.proliferatorTaken }));
    const receivedAtStart = new Map<number, number>();
    for (const id of [targetItem, ...exportItems]) receivedAtStart.set(id, received(id));
    sumTick = 0;
    sumIdleTick = 0;
    streak = 0;
    longestStreak = 0;
    measuring = true;
    runTicks(measureTicks);
    measuring = false;

    const rate = (itemId: number): number => (received(itemId) - (receivedAtStart.get(itemId) ?? 0)) / measureSeconds;
    const machineStats: MachineStat[] = machines.list.map((m) => ({
      buildingId: m.buildingId,
      stageIndex: m.stageIndex,
      crafts: m.machine.crafts,
      busyFraction: m.machine.busyTicks / measureTicks,
      outputBlockedFraction: m.machine.stalledTicks / measureTicks,
      starvedFraction: m.machine.starvedTicks / measureTicks,
    }));
    const stageStats: StageStat[] = plan.stages.map((stage, stageIndex) => ({
      stageIndex,
      crafts: machineStats.reduce((sum, m) => (m.stageIndex === stageIndex ? sum + m.crafts : sum), 0),
      plannedCrafts: stage.craftsPerSecond * measureSeconds,
    }));

    let chargePerTick = 0;
    for (const b of layout.buildings) chargePerTick += b.station?.chargePerTick ?? 0;
    const stationChargeW = chargePerTick * tps;

    let sprayedItems = 0;
    let proliferatorTaken = 0;
    coaters.forEach((c, i) => {
      sprayedItems += c.sprayedItems - coatersAtStart[i].sprayed;
      proliferatorTaken += c.proliferatorTaken - coatersAtStart[i].taken;
    });

    return {
      measuredTargetRate: rate(targetItem),
      measuredExports: exportItems.map((itemId) => ({ itemId, perSecond: rate(itemId) })),
      machineStats,
      stageStats,
      coaters: { count: coaters.length, sprayedItems, proliferatorPerSecond: proliferatorTaken / measureSeconds },
      deadlocked: expectsOutput && longestStreak >= DEADLOCK_TICKS,
      power: {
        steadyW: (sumTick / measureTicks) * tps,
        idleW: (sumIdleTick / measureTicks) * tps,
        peakW: peakTick * tps + stationChargeW,
        stationChargeW,
      },
      measureSeconds,
      warmupTicksUsed,
      warnings,
    };
  };

  let measured = measure();
  const acceptable = opts.acceptable;
  if (stored && acceptable && !acceptable(measured)) {
    // A start-up still going on has not been judged. The window just measured was warm-up as far as the next one is concerned;
    // the run warms up on, a window at a time, while the total stored in belts and machines keeps growing and the limit allows,
    // and then measures as it did the first time. That measurement is the result: no window in between is looked at.
    // A cap of MAX_WARMUP_TICKS or more is no cap here either (see `SimOptions.warmupCapTicks`).
    const cap = opts.warmupCapTicks !== undefined && opts.warmupCapTicks < MAX_WARMUP_TICKS ? opts.warmupCapTicks : Infinity;
    const limit = Math.min(MAX_FILL_WARMUP_TICKS, cap);
    let used = warmupTicksUsed + measureTicks;
    if (stillFilling(stored) && used + FILL_STEP_TICKS <= limit) {
      do {
        runTicks(FILL_STEP_TICKS);
        used += FILL_STEP_TICKS;
      } while (stillFilling(stored) && used + FILL_STEP_TICKS <= limit);
      warmupTicksUsed = used;
      measured = measure();
    }
  }
  return measured;
}

/**
 * Whether a start-up is still going on, from `stored`, the total of what belts and machines hold sampled every
 * `STORED_SAMPLE_TICKS`: it is if, for one of the `FILL_WINDOW_TICKS`, the total grew in each of the last two windows of that
 * length (or half of what there is, if that is less) by more than `FILL_SIGMAS` times its jitter and `FILL_MIN`. The jitter is
 * what a straight line fitted to the total over the last window leaves over: a block that has settled swings about its level by a
 * few cargo (a Processor line by 2, a Quantum Chip plan by 60-90) and a window that grew by no more than that proves nothing. (The
 * fast fill of the first minutes bends the total in the window before the last, which it would otherwise count as jitter.)
 */
export function stillFilling(stored: readonly number[]): boolean {
  const last = stored.length - 1;
  const seen = new Set<number>();
  for (const ticks of FILL_WINDOW_TICKS) {
    const w = Math.min(ticks / STORED_SAMPLE_TICKS, Math.floor(last / 2));
    if (w < 4 || seen.has(w)) continue;
    seen.add(w);
    const needs = Math.max(FILL_MIN, FILL_SIGMAS * lineResidual(stored, last - w, last));
    if (stored[last] - stored[last - w] > needs && stored[last - w] - stored[last - 2 * w] > needs) return true;
  }
  return false;
}

/** The standard deviation of `values[from..to]` about the least-squares straight line through them. */
function lineResidual(values: readonly number[], from: number, to: number): number {
  const n = to - from + 1;
  let mean = 0;
  for (let i = from; i <= to; i++) mean += values[i];
  mean /= n;
  const centre = (n - 1) / 2;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (i - centre) ** 2;
    sxy += (i - centre) * (values[from + i] - mean);
  }
  const slope = sxy / sxx;
  let sumSquares = 0;
  for (let i = 0; i < n; i++) sumSquares += (values[from + i] - mean - slope * (i - centre)) ** 2;
  return Math.sqrt(sumSquares / Math.max(1, n - 2));
}

/** One tick's power demand, in J/tick, and the part of it that is idle draw. Reports to the world as it is added. */
class PowerMeter {
  total = 0;
  idle = 0;
  constructor(private readonly world: World) {}

  add(joulesPerTick: number, idle: boolean): void {
    this.total += joulesPerTick;
    if (idle) this.idle += joulesPerTick;
    this.world.addPowerDemand(joulesPerTick);
  }

  endTick(): void {
    this.total = 0;
    this.idle = 0;
  }
}

interface MachineEntry {
  buildingId: number;
  stageIndex: number | null;
  machine: MachineSim;
}

/** A machine in every production building and lab that has a recipe, in layout order. */
function addMachines(
  world: World,
  layout: Layout,
  plan: ProductionPlan,
  data: GameDataIndex,
  meter: PowerMeter,
  progress: { count: number },
  warnings: string[],
): { list: MachineEntry[]; byBuilding: Map<number, MachineSim> } {
  const firstStageOfRecipe = new Map<number, number>();
  plan.stages.forEach((stage, i) => {
    if (!firstStageOfRecipe.has(stage.recipeId)) firstStageOfRecipe.set(stage.recipeId, i);
  });
  const defaultMode = plan.request.proliferator.mode === 'speed' ? 1 : 0;
  const list: MachineEntry[] = [];
  const byBuilding = new Map<number, MachineSim>();
  for (const b of layout.buildings) {
    if (b.recipeId === undefined) continue;
    const def = data.building(b.itemId);
    if (!def) {
      warnings.push(`building ${b.id} has recipe ${b.recipeId} but item ${b.itemId} is not a building in GameData; it is not simulated`);
      continue;
    }
    if (def.kind !== 'production' && def.kind !== 'lab') {
      warnings.push(
        `building ${b.id} (${def.name}) has recipe ${b.recipeId} but the simulator has no model for a ${def.kind}; its stage will read as stalled`,
      );
      continue;
    }
    const recipe = recipeOrNull(data, b.recipeId);
    if (!recipe) {
      warnings.push(`building ${b.id} (${def.name}) has recipe ${b.recipeId}, which GameData does not have; it is not simulated`);
      continue;
    }
    const machine = new MachineSim(machineConfig(def, recipe, data, b.prolifMode ?? defaultMode));
    const tag = b.role === undefined ? null : STAGE_ROLE.exec(b.role);
    const byRole = tag ? Number(tag[1]) : undefined;
    const stageIndex = byRole !== undefined && plan.stages[byRole] ? byRole : (firstStageOfRecipe.get(b.recipeId) ?? null);
    list.push({ buildingId: b.id, stageIndex, machine });
    byBuilding.set(b.id, machine);
    world.addEntity(machineEntity(world, machine, meter, progress), 'machines');
  }
  return { list, byBuilding };
}

/**
 * A `LabStack` for every stack of machines the layout declares through `stackParentId` (MX §4.4): the machine of the
 * bottom building first, each next one on the one before. It ticks after the machines, in the same step.
 */
function addLabStacks(world: World, layout: Layout, machines: Map<number, MachineSim>, warnings: string[]): void {
  const above = new Map<number, PlacedBuilding>();
  for (const b of layout.buildings) {
    const below = b.stackParentId;
    if (below === undefined || !machines.has(b.id) || !machines.has(below)) continue;
    const taken = above.get(below);
    if (taken) {
      warnings.push(`buildings ${taken.id} and ${b.id} are both stacked on building ${below}; only ${taken.id} is linked`);
      continue;
    }
    above.set(below, b);
  }
  for (const b of layout.buildings) {
    const bottom = machines.get(b.id);
    if (!bottom || !above.has(b.id)) continue;
    if (b.stackParentId !== undefined && machines.has(b.stackParentId)) continue; // not the bottom of its stack
    const labs = [bottom];
    for (let next = above.get(b.id); next && labs.length <= layout.buildings.length; next = above.get(next.id)) {
      labs.push(machines.get(next.id) as MachineSim);
    }
    const stack = new LabStack(labs);
    world.addEntity({ tick: () => stack.tick() }, 'machines');
  }
}

function machineEntity(world: World, machine: MachineSim, meter: PowerMeter, progress: { count: number }): SimEntity {
  return {
    tick() {
      machine.tick(world.powerRatio);
      if (machine.state === 'busy') progress.count++;
      meter.add(machine.powerDemand(), !machine.working);
    },
  };
}

/** A sorter in every layout sorter whose two ends the simulator can model. Others are skipped with a warning. */
function addSorters(
  world: World,
  layout: Layout,
  data: GameDataIndex,
  effects: TechEffects,
  buildingById: Map<number, PlacedBuilding>,
  machines: Map<number, MachineSim>,
  meter: PowerMeter,
  progress: { count: number },
  warnings: string[],
): void {
  const resolve = (s: Sorter, end: Endpoint, which: 'pick' | 'drop'): BeltRef | MachineSim | null => {
    if (end.kind === 'belt') return world.beltCell(end.beltId, end.node);
    const b = buildingById.get(end.buildingId);
    if (!b) throw new Error(`sorter ${s.id} ${which}: no building ${end.buildingId} in the layout`);
    const machine = machines.get(b.id);
    if (!machine) {
      warnings.push(
        `sorter ${s.id} ${which}: building ${b.id} (${buildingName(data, b)}) is not a machine the simulator models; the sorter is skipped`,
      );
      return null;
    }
    return machine;
  };
  for (const s of layout.sorters) {
    const proto = data.building(s.tierItemId);
    if (!proto?.sorter) throw new Error(`sorter ${s.id}: item ${s.tierItemId} is not a sorter in GameData`);
    const pick = resolve(s, s.pick, 'pick');
    const drop = resolve(s, s.drop, 'drop');
    if (pick === null || drop === null) continue;
    const sorter = new SorterSim({ ...sorterSettings(proto.sorter, s.span, effects), pick, drop, filter: s.filterItemId });
    world.addEntity(sorterEntity(world, sorter, proto, meter, progress), 'sorters');
  }
}

function sorterEntity(world: World, sorter: SorterSim, proto: Building, meter: PowerMeter, progress: { count: number }): SimEntity {
  const work = proto.power.workPerTick;
  const idle = proto.power.idlePerTick;
  return {
    tick() {
      const before = sorter.itemsMoved;
      sorter.tick(world.powerRatio);
      if (sorter.itemsMoved !== before) progress.count++;
      const working = sorter.workingThisTick();
      meter.add(working ? work : idle, !working);
    },
  };
}

/**
 * A coater in every `layout.coaters` entry (a layout without the field has none). The proliferator belt is the one that has
 * a node at the coater's exact top passage (`findCoaterTop`: one node upstream of the coater, one level up), the same
 * point COATER_UNFED looks for; a coater without one warns and never sprays. Returns the coaters that were wired.
 */
function addCoaters(world: World, layout: Layout, data: GameDataIndex, meter: PowerMeter, warnings: string[]): CoaterSim[] {
  const placements = layout.coaters;
  if (!placements || placements.length === 0) return [];
  const def = sprayCoaterDef(data);
  if (!def?.sprayCoater) {
    warnings.push('the layout has spray coaters but GameData has no spray coater building; they are ignored');
    return [];
  }
  const proliferators = coaterProliferators(def);
  const beltById = new Map(layout.belts.map((belt) => [belt.id, belt]));
  const wired: CoaterSim[] = [];
  for (const c of placements) {
    const itemBelt = beltById.get(c.beltId);
    const pose = coaterBuilding(c, itemBelt, def);
    if (!itemBelt || !pose) throw new Error(`coater ${c.id}: no node ${c.node} on belt ${c.beltId}`);
    const top = findCoaterTop(layout, pose, proliferators);
    if (top === null) {
      warnings.push(`coater ${c.id}: no proliferator belt passes above node ${c.node} of belt ${c.beltId}; it never sprays`);
      continue;
    }
    const coater = new CoaterSim(coaterConfig(def, world.beltCell(c.beltId, c.node), world.beltCell(top.belt.id, top.node), data));
    wired.push(coater);
    const work = def.power.workPerTick;
    const idle = def.power.idlePerTick;
    world.addEntity(
      {
        tick() {
          coater.tick(world.powerRatio);
          const working = coater.workingThisTick();
          meter.add(working ? work : idle, !working);
        },
      },
      'coaters',
    );
  }
  return wired;
}

/**
 * Station belt ports that the world ignores or that cannot work: an end of a belt on a port that is not configured
 * for it, or on an item the station has no slot for. The belt then stays empty or backs up, which shows up as a low
 * output, and these messages say why.
 */
function stationWarnings(layout: Layout, data: GameDataIndex, buildingById: Map<number, PlacedBuilding>): string[] {
  const warnings: string[] = [];
  for (const belt of layout.belts) {
    const source = belt.source;
    const sourceBuilding = source ? buildingById.get(source.buildingId) : undefined;
    if (source && sourceBuilding?.station) {
      const cfg = sourceBuilding.station;
      const where = `belt ${belt.id}: station ${sourceBuilding.id} (${buildingName(data, sourceBuilding)}) port ${source.port}`;
      const port = cfg.ports[source.port];
      const slot = port && port.storageIdx >= 1 ? cfg.slots[port.storageIdx - 1] : undefined;
      if (!port || port.dir !== 1) {
        warnings.push(`${where} is not an output port (dir ${port?.dir ?? 'missing'}); the belt stays empty`);
      } else if (!slot || slot.itemId === 0) {
        warnings.push(`${where} outputs no item (storage index ${port.storageIdx}); the belt stays empty`);
      } else if (belt.itemId !== 0 && slot.itemId !== belt.itemId) {
        warnings.push(`${where} outputs ${itemName(data, slot.itemId)} but the belt is planned to carry ${itemName(data, belt.itemId)}`);
      }
    }
    const sink = belt.sink;
    const sinkBuilding = sink?.kind === 'port' ? buildingById.get(sink.buildingId) : undefined;
    if (sink?.kind === 'port' && sinkBuilding?.station) {
      const cfg = sinkBuilding.station;
      const where = `belt ${belt.id}: station ${sinkBuilding.id} (${buildingName(data, sinkBuilding)}) input port ${sink.port}`;
      const port = cfg.ports[sink.port];
      if (!port || port.dir !== 2) {
        warnings.push(`${where} is not an input port (dir ${port?.dir ?? 'missing'}); the belt backs up`);
      } else if (belt.itemId !== 0 && !cfg.slots.some((s) => s.itemId === belt.itemId)) {
        warnings.push(`${where} has no storage slot for ${itemName(data, belt.itemId)}; the belt backs up`);
      }
    }
  }
  return warnings;
}
