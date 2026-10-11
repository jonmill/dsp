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
import type { Endpoint, Layout, PlacedBuilding, Sorter } from '../../geometry';
import { CoaterSim, coaterConfig } from './coater';
import { MachineSim, machineConfig } from './machine';
import { SorterSim, sorterSettings } from './sorter';
import type { BeltRef } from './sorter';
import { World } from './world';
import type { SimEntity } from './world';

export interface SimOptions {
  /**
   * Ticks to run before measuring, used exactly. Omitted: adaptive. The warm-up then runs in windows of 3600 ticks and
   * stops after the first window in which the target item reaches 99.9 % of the provisioned rate, or once two
   * consecutive windows (both above zero) agree within 1 %: whichever comes first, but never before one window and
   * never after 72000 ticks (20 game minutes). `SimResult.warmupTicksUsed` says how long it ran.
   */
  warmupTicks?: number;
  /** Ticks measured. Default 18000 (5 game minutes). */
  measureTicks?: number;
  /** Power the block's network can supply, in watts. Omitted: unlimited (serve ratio 1). */
  powerSupplyW?: number;
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
  /** The length of the measurement window, in seconds. */
  measureSeconds: number;
  /** The ticks run before the window: `SimOptions.warmupTicks` as given, else what the adaptive warm-up needed. */
  warmupTicksUsed: number;
  /** Things the simulator saw in the layout that make it act differently from what was meant (mis-wired ports...). */
  warnings: string[];
}

/** The adaptive warm-up runs in windows of this many ticks (1 game minute) and always runs at least one. */
const WARMUP_WINDOW_TICKS = 3600;
/** The adaptive warm-up gives up on a steady state after this many ticks (20 game minutes). */
const MAX_WARMUP_TICKS = 72000;
/** Two consecutive warm-up windows agree when their rates differ by at most this share of the larger one. */
const WARMUP_AGREEMENT = 0.01;
/** A warm-up window that makes this share of the provisioned rate ends the adaptive warm-up. */
const WARMUP_REACHED = 0.999;
const DEFAULT_MEASURE_TICKS = 18000;
/** Consecutive measured ticks without progress that make a deadlock. */
export const DEADLOCK_TICKS = 600;
const STAGE_ROLE = /^stage:(\d+)$/;
/** A proliferator belt passes a coater's top passage one level above the item belt (Task 28's layout pattern). */
const COATER_TOP_LEVELS = 1;
/** How far, in tiles, a proliferator belt node may be from the coater's belt node and still be its top passage. */
const COATER_TOP_REACH_TILES = 1.5;

/** What `Layout.coaters` holds once Task 28 adds it. Read through an optional field so older layouts stay valid. */
interface CoaterPlacement {
  id: number;
  beltId: number;
  node: number;
}

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
  addSorters(world, layout, data, effects, buildingById, machines.byBuilding, meter, progress, warnings);
  addCoaters(world, layout, data, meter, warnings);

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

  let warmupTicksUsed = 0;
  if (opts.warmupTicks !== undefined) {
    for (; warmupTicksUsed < opts.warmupTicks; warmupTicksUsed++) world.tick();
  } else {
    // Adaptive: windows of the target's rate until it is steady (or as good as provisioned), at least one, at most 72000 ticks.
    const wanted = provisionedRate(plan);
    let previous = 0;
    while (warmupTicksUsed < MAX_WARMUP_TICKS) {
      const before = received(targetItem);
      for (let t = 0; t < WARMUP_WINDOW_TICKS; t++) world.tick();
      warmupTicksUsed += WARMUP_WINDOW_TICKS;
      const windowRate = (received(targetItem) - before) / (WARMUP_WINDOW_TICKS / tps);
      if (wanted > 0 && windowRate >= WARMUP_REACHED * wanted) break;
      // a rate of zero twice is not steady: a long belt or a deep chain has not delivered yet
      if (previous > 0 && windowRate > 0 && Math.abs(windowRate - previous) <= WARMUP_AGREEMENT * Math.max(windowRate, previous)) break;
      previous = windowRate;
    }
  }
  for (const m of machines.list) m.machine.resetStats();
  const receivedAtStart = new Map<number, number>();
  for (const id of [targetItem, ...exportItems]) receivedAtStart.set(id, received(id));
  measuring = true;
  for (let t = 0; t < measureTicks; t++) world.tick();

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

  return {
    measuredTargetRate: rate(targetItem),
    measuredExports: exportItems.map((itemId) => ({ itemId, perSecond: rate(itemId) })),
    machineStats,
    stageStats,
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
 * A coater in every `layout.coaters` entry (a field Task 28 adds; absent in older layouts, which keeps this inert).
 * The proliferator belt is the one carrying a proliferator that has a node one level above the coater's belt node,
 * within `COATER_TOP_REACH_TILES` tiles; Task 28 can tighten this to the prefab's exact top-passage point.
 */
function addCoaters(world: World, layout: Layout, data: GameDataIndex, meter: PowerMeter, warnings: string[]): void {
  const placements = (layout as { coaters?: readonly CoaterPlacement[] }).coaters;
  if (!placements || placements.length === 0) return;
  const def = data.data.buildings.find((b) => b.kind === 'sprayCoater');
  if (!def?.sprayCoater) {
    warnings.push('the layout has spray coaters but GameData has no spray coater building; they are ignored');
    return;
  }
  const proliferators = new Set(def.sprayCoater.incItemIds);
  for (const c of placements) {
    const itemBelt = layout.belts.find((belt) => belt.id === c.beltId);
    const at = itemBelt?.nodes[c.node];
    if (!itemBelt || !at) throw new Error(`coater ${c.id}: no node ${c.node} on belt ${c.beltId}`);
    let top: { beltId: number; node: number } | null = null;
    let topDistance = Infinity;
    for (const belt of layout.belts) {
      if (belt.id === itemBelt.id || !proliferators.has(belt.itemId)) continue;
      for (let node = 0; node < belt.nodes.length; node++) {
        const p = belt.nodes[node];
        if (p.z - at.z !== COATER_TOP_LEVELS) continue;
        const distance = Math.hypot(p.x - at.x, p.y - at.y);
        if (distance <= COATER_TOP_REACH_TILES && distance < topDistance) {
          top = { beltId: belt.id, node };
          topDistance = distance;
        }
      }
    }
    if (top === null) {
      warnings.push(`coater ${c.id}: no proliferator belt passes above node ${c.node} of belt ${c.beltId}; it never sprays`);
      continue;
    }
    const coater = new CoaterSim(coaterConfig(def, world.beltCell(c.beltId, c.node), world.beltCell(top.beltId, top.node), data));
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
