// Machine simulation: smelters, assemblers, chemical plants, refineries, colliders (`AssemblerComponent`, MX §4.3)
// and labs in matrix-producing mode (`LabComponent`, MX §4.4). A machine is a buffer of ingredients and a buffer of
// products around a progress counter; sorters fill the one (`InsertTarget`) and empty the other (`PickSource`).
//
// Units. `time` counts in 1/10000 ticks: a recipe needs `timeTicks · 10000`, a 1x machine adds 10000 per tick
// (`speed` = the prefab's 10000 = 1x), so a craft takes `timeTicks · 10000 / (speed · power)` ticks.
//
// What this port settles where MX §4.3 is open:
//  - Order inside a tick: bonus products, then a finished craft (blocked or delivered), then the start of the next
//    craft, then progress. A craft that finishes and restarts in the same tick keeps its `time` remainder.
//  - `needs(item)` reads the live buffers, not a per-tick array the game refreshes once. A second sorter delivering
//    in the same tick therefore sees the first one's items; the game would not. This only matters when two sorters
//    feed one machine within a tick and errs towards less overshoot.
//  - `split_inc_level` is ported from memory of the decompile: with `n` items and `m` points served, `avg = m / n`
//    and `rem = m - avg · n` items hold one point more; taking `p` items leaves `n - p`, so the `rem - (n - p)` extra
//    points beyond the remaining items go to the taken ones; the level is `avg`, one more if any extra point is taken.
//    For stacks sprayed at one tier (every item the same) this is exactly that tier's level.
//  - Extra products and the speed-up are chosen per craft from the lowest level over the ingredients. A recipe that
//    cannot take extra products (`canUseExtra`) gets the speed-up in either mode, as the planner assumes.
//  - Labs stack (`LabStack`, labstack.ts): `passIngredientsUp` and `pullProductsDown` are the two moves between a lab
//    and the one above it. MX §4.4 gives the rules but not the order of the game's loops, so: a lab keeps
//    `requireCount + 1 + floor(speed / 20000)` of an ingredient, passes the rest up at most 5 an item a tick and only
//    while the lab above wants it (below its own input threshold); products come down in one move, up to the room the
//    lower lab has below `10 · ceil(speed / 10000) - 2`. The proliferator points of passed items move with them.
import { canUseExtra } from '../../calc/proliferator';
import type { Building, GameDataIndex, ItemCount, Recipe, RecipeType } from '../../data';
import type { InsertTarget, PickSource } from './sorter';

/** `InserterComponent`-style serve ratio below which a machine freezes (MX §6.2). */
const MIN_POWER = 0.1;
/** `time` units per tick at 1x speed, and per tick of recipe time. */
const TIME_UNIT = 10000;
/** The extra-product accumulator needs 10 crafts' time per full bonus at 100 % (MX §4.3). */
const EXTRA_TIME_FACTOR = 10;
/** The cargo tables have entries 0..10. */
const MAX_INC_LEVEL = 10;
/** A lab buffers `10 · ceil(speed)` matrices (MX §4.4). */
const LAB_OUTPUT_PER_SPEED = 10;
/** A lab recipe longer than this many ticks only ever wants 6 of each ingredient (MX §4.4). */
const LAB_LONG_RECIPE_TICKS = 540;
const LAB_LONG_RECIPE_LIMIT = 6;
/** A stacked lab passes at most this many items of an ingredient up per tick (MX §4.4). */
const LAB_PASS_UP_PER_TICK = 5;
/** A lab keeps `requireCount + 1 + floor(speed / this)` of an ingredient when it passes the rest up (MX §4.4). */
const LAB_KEEP_SPEED_DIVISOR = 20000;
/** The lower lab of a stack pulls products down until it holds the output cap less this many (MX §4.4). */
const LAB_PULL_MARGIN = 2;

export type MachineState = 'busy' | 'blocked' | 'starved' | 'unpowered';

/** Everything a machine needs to know, as plain numbers: see `machineConfig` for the GameData mapping. */
export interface MachineConfig {
  /** A lab in matrix-producing mode (different input threshold and output cap). */
  lab: boolean;
  recipeType: RecipeType;
  timeTicks: number;
  inputs: readonly ItemCount[];
  outputs: readonly ItemCount[];
  /** The prefab speed: 10000 = 1x. */
  speed: number;
  /** J/tick. */
  workPerTick: number;
  idlePerTick: number;
  /** 0 extra products, 1 speed-up. */
  mode: 0 | 1;
  /** The recipe can take extra products (`canUseExtra`). */
  productive: boolean;
  incTableMilli: readonly number[];
  accTableMilli: readonly number[];
  powerTableRatio: readonly number[];
  /** `GameData.constants.assemblerOutputCrafts`. */
  outputCaps: { SMELT_items: number; ASSEMBLE_crafts: number; OTHER_crafts: number };
}

/**
 * The config of building `def` running `recipe`, with proliferator `mode` (0 extra products, 1 speed-up).
 * Throws, naming the building, if it is not a production building or a lab.
 */
export function machineConfig(def: Building, recipe: Recipe, data: GameDataIndex, mode: 0 | 1): MachineConfig {
  const speed = def.production?.speed ?? def.lab?.assembleSpeed;
  if (speed === undefined) throw new Error(`building ${def.itemId} (${def.name}) is not a production building or a lab`);
  const c = data.data.constants;
  return {
    lab: def.kind === 'lab',
    recipeType: recipe.type,
    timeTicks: recipe.timeTicks,
    inputs: recipe.inputs,
    outputs: recipe.outputs,
    speed,
    workPerTick: def.power.workPerTick,
    idlePerTick: def.power.idlePerTick,
    mode,
    productive: canUseExtra(recipe, data),
    incTableMilli: c.incTableMilli,
    accTableMilli: c.accTableMilli,
    powerTableRatio: c.powerTableRatio,
    outputCaps: c.assemblerOutputCrafts,
  };
}

const STATES: readonly MachineState[] = ['busy', 'blocked', 'starved', 'unpowered'];
const BUSY = 0;
const BLOCKED = 1;
const STARVED = 2;
const UNPOWERED = 3;

export class MachineSim implements InsertTarget, PickSource {
  /** Assemblers, labs and the like only take what they need. */
  readonly careNeeds = true;
  /** Crafts finished, products delivered to the buffer. */
  crafts = 0;
  /** Ticks spent replicating. */
  busyTicks = 0;
  /** Ticks a finished craft waited for room in the output buffer. */
  stalledTicks = 0;
  /** Ticks spent without the ingredients to start. */
  starvedTicks = 0;

  private readonly cfg: MachineConfig;
  private readonly inItems: Int32Array;
  private readonly inCounts: Int32Array;
  private readonly outItems: Int32Array;
  private readonly outCounts: Int32Array;
  private readonly servedCount: Int32Array;
  private readonly servedInc: Int32Array;
  private readonly producedCount: Int32Array;
  /** The output buffer blocks a finished craft when a product's count exceeds its entry here. */
  private readonly blockAbove: Int32Array;
  /** Wanted ingredient count per input: `served[i] < inLimit[i]` means the machine needs item i. */
  private readonly inLimit: Int32Array;
  private readonly timeSpend: number;
  private readonly extraTimeSpend: number;

  private time = 0;
  private extraTime = 0;
  private replicating = false;
  private speedOverrideValue: number;
  private extraSpeed = 0;
  /** `powerTable[L]` of the running craft, in thousandths. */
  private extraPower = 0;
  private stateNo = STARVED;

  constructor(cfg: MachineConfig) {
    this.cfg = cfg;
    this.inItems = Int32Array.from(cfg.inputs, (i) => i.itemId);
    this.inCounts = Int32Array.from(cfg.inputs, (i) => i.count);
    this.outItems = Int32Array.from(cfg.outputs, (o) => o.itemId);
    this.outCounts = Int32Array.from(cfg.outputs, (o) => o.count);
    this.servedCount = new Int32Array(cfg.inputs.length);
    this.servedInc = new Int32Array(cfg.inputs.length);
    this.producedCount = new Int32Array(cfg.outputs.length);
    this.inLimit = new Int32Array(cfg.inputs.length);
    this.timeSpend = cfg.timeTicks * TIME_UNIT;
    this.extraTimeSpend = this.timeSpend * EXTRA_TIME_FACTOR;
    this.speedOverrideValue = cfg.speed;
    this.blockAbove = Int32Array.from(cfg.outputs, (o) => outputBlockAbove(cfg, o.count));
    this.updateNeeds();
  }

  /** The state after the last tick. */
  get state(): MachineState {
    return STATES[this.stateNo];
  }

  /** Whether a craft is running, which is what draws work power. */
  get working(): boolean {
    return this.replicating;
  }

  /** The speed of the running (or last) craft: the prefab speed, raised by a speed-up. */
  get speedOverride(): number {
    return this.speedOverrideValue;
  }

  /** Ingredient item ids, in recipe order. */
  ingredientItems(): readonly number[] {
    return Array.from(this.inItems);
  }

  /** Product item ids, in recipe order. */
  productItems(): readonly number[] {
    return Array.from(this.outItems);
  }

  /** Ingredient `item` waiting in the buffer (0 for an item that is no ingredient). */
  served(item: number): number {
    const i = this.inItems.indexOf(item);
    return i < 0 ? 0 : this.servedCount[i];
  }

  /** Proliferator points held by the waiting ingredient `item` (0 for an item that is no ingredient). */
  servedPoints(item: number): number {
    const i = this.inItems.indexOf(item);
    return i < 0 ? 0 : this.servedInc[i];
  }

  /** Product `item` waiting in the buffer (0 for an item that is no product). */
  produced(item: number): number {
    const i = this.outItems.indexOf(item);
    return i < 0 ? 0 : this.producedCount[i];
  }

  /** Everything waiting in the buffers: ingredients and products. */
  stored(): number {
    let sum = 0;
    for (let i = 0; i < this.servedCount.length; i++) sum += this.servedCount[i];
    for (let j = 0; j < this.producedCount.length; j++) sum += this.producedCount[j];
    return sum;
  }

  /** Zero the counters; buffers and progress stay. */
  resetStats(): void {
    this.crafts = 0;
    this.busyTicks = 0;
    this.stalledTicks = 0;
    this.starvedTicks = 0;
  }

  /** Whether the machine wants `item` now: it is an ingredient and its buffer is below the threshold of MX §4.3. */
  needs(item: number): boolean {
    const i = this.inItems.indexOf(item);
    return i >= 0 && this.servedCount[i] < this.inLimit[i];
  }

  /** Whether the machine wants any ingredient: the opposite of the game's "needs all zero". */
  needsAny(): boolean {
    for (let i = 0; i < this.inItems.length; i++) if (this.servedCount[i] < this.inLimit[i]) return true;
    return false;
  }

  /** Add `count` items carrying `inc` points. False for an item that is no ingredient. No cap: `needs` gates sorters. */
  insert(item: number, count: number, inc: number): boolean {
    const i = this.inItems.indexOf(item);
    if (i < 0) return false;
    this.servedCount[i] += count;
    this.servedInc[i] += inc;
    return true;
  }

  /** One product of kind `filter` (0 = any) that `accept` allows, or null. Ingredients are never offered (MX §3.3). */
  pickProduct(filter: number, accept: (item: number) => boolean): { item: number; count: number; inc: number } | null {
    for (let j = 0; j < this.outItems.length; j++) {
      const item = this.outItems[j];
      if (this.producedCount[j] <= 0 || (filter !== 0 && item !== filter) || !accept(item)) continue;
      this.producedCount[j]--;
      return { item, count: 1, inc: 0 };
    }
    return null;
  }

  // mirrors: LabComponent.InternalUpdateAssemble
  /**
   * Stack pass-up (MX §4.4): for each ingredient `upper` also takes, this lab keeps `requireCount + 1 + floor(speed /
   * 20000)` and gives `upper` what it has beyond that, at most 5 items, and no more than `upper` still wants. The
   * proliferator points move in proportion to the items.
   */
  passIngredientsUp(upper: MachineSim): void {
    for (let i = 0; i < this.inItems.length; i++) {
      const j = upper.inItems.indexOf(this.inItems[i]);
      if (j < 0) continue;
      const keep = this.inCounts[i] + 1 + Math.floor(this.speedOverrideValue / LAB_KEEP_SPEED_DIVISOR);
      const give = Math.min(LAB_PASS_UP_PER_TICK, this.servedCount[i] - keep, upper.inLimit[j] - upper.servedCount[j]);
      if (give <= 0) continue;
      const inc = Math.floor((this.servedInc[i] * give) / this.servedCount[i]);
      this.servedCount[i] -= give;
      this.servedInc[i] -= inc;
      upper.servedCount[j] += give;
      upper.servedInc[j] += inc;
    }
  }

  // mirrors: LabComponent.InternalUpdateAssemble
  /**
   * Stack pass-down (MX §4.4): this lab takes the products `upper` holds until it has `10 · ceil(speed / 10000) - 2`
   * of each, so the sorters at the bottom of a stack unload all of it.
   */
  pullProductsDown(upper: MachineSim): void {
    const room = LAB_OUTPUT_PER_SPEED * Math.ceil(this.cfg.speed / TIME_UNIT) - LAB_PULL_MARGIN;
    for (let j = 0; j < this.outItems.length; j++) {
      const k = upper.outItems.indexOf(this.outItems[j]);
      if (k < 0) continue;
      const take = Math.min(room - this.producedCount[j], upper.producedCount[k]);
      if (take <= 0) continue;
      this.producedCount[j] += take;
      upper.producedCount[k] -= take;
    }
  }

  /** J/tick the machine asks for next tick: work power (raised by the proliferator level) while replicating, else idle. */
  powerDemand(): number {
    return this.replicating
      ? (this.cfg.workPerTick * (1000 + this.extraPower)) / 1000
      : this.cfg.idlePerTick;
  }

  // mirrors: AssemblerComponent.InternalUpdate
  /** One tick at serve ratio `power` (MX §4.3). Below 10 % power the machine does nothing, not even start a craft. */
  tick(power: number): void {
    if (!(power >= MIN_POWER)) {
      this.stateNo = UNPOWERED;
      return;
    }
    if (this.extraTime >= this.extraTimeSpend) {
      this.addProducts(); // bonus batch: not subject to the output check
      this.extraTime -= this.extraTimeSpend;
    }
    if (this.time >= this.timeSpend) {
      this.replicating = false;
      if (this.outputBlocked()) {
        this.stateNo = BLOCKED;
        this.stalledTicks++;
        return;
      }
      this.addProducts();
      this.time -= this.timeSpend;
      this.crafts++;
    }
    if (!this.replicating && !this.tryStart()) {
      this.time = 0;
      this.stateNo = STARVED;
      this.starvedTicks++;
      return;
    }
    if (this.time < this.timeSpend && this.extraTime < this.extraTimeSpend) {
      this.time += Math.trunc(power * this.speedOverrideValue);
      this.extraTime += Math.trunc(power * this.extraSpeed);
    }
    this.stateNo = BUSY;
    this.busyTicks++;
  }

  // mirrors: AssemblerComponent.UpdateNeeds
  /**
   * The ingredient thresholds. Production buildings want `requireCount · N` of each ingredient with
   * `N = max(2, floor(speedOverride · 180 / timeSpend) + 1)`: about 3 s of work. Recomputed whenever the speed
   * override changes, which is when a craft starts.
   */
  private updateNeeds(): void {
    if (this.cfg.lab) {
      const limit = this.labInputLimit();
      this.inLimit.fill(limit);
      return;
    }
    const n = Math.max(2, Math.floor((this.speedOverrideValue * 180) / this.timeSpend) + 1);
    for (let i = 0; i < this.inLimit.length; i++) this.inLimit[i] = this.inCounts[i] * n;
  }

  // mirrors: LabComponent.InternalUpdateAssemble
  /**
   * A lab in matrix-producing mode wants `3 · floor((speed + 5001) / 10000) + 3` of each ingredient (6 for a Matrix
   * Lab, 12 for a Self-evolution Lab), and 6 for a recipe longer than 540 ticks (MX §4.4).
   */
  private labInputLimit(): number {
    if (this.cfg.timeTicks > LAB_LONG_RECIPE_TICKS) return LAB_LONG_RECIPE_LIMIT;
    return 3 * Math.floor((this.speedOverrideValue + 5001) / TIME_UNIT) + 3;
  }

  /** Whether any product is over its cap, so a finished craft cannot be added (MX §4.3: any one blocks them all). */
  private outputBlocked(): boolean {
    for (let j = 0; j < this.producedCount.length; j++) if (this.producedCount[j] > this.blockAbove[j]) return true;
    return false;
  }

  private addProducts(): void {
    for (let j = 0; j < this.producedCount.length; j++) this.producedCount[j] += this.outCounts[j];
  }

  /** Consume one craft's ingredients and set the mode of the craft, if every ingredient is there. */
  private tryStart(): boolean {
    const n = this.servedCount.length;
    for (let i = 0; i < n; i++) if (this.servedCount[i] < this.inCounts[i]) return false;
    let level = n === 0 ? 0 : MAX_INC_LEVEL;
    for (let i = 0; i < n; i++) {
      const split = splitIncLevel(this.servedCount[i], this.servedInc[i], this.inCounts[i]);
      this.servedCount[i] = split.left;
      this.servedInc[i] = split.leftInc;
      if (split.level < level) level = split.level;
    }
    level = Math.min(level, MAX_INC_LEVEL);
    const cfg = this.cfg;
    if (cfg.productive && cfg.mode === 0) {
      this.extraSpeed = Math.trunc((cfg.speed * cfg.incTableMilli[level] * EXTRA_TIME_FACTOR) / 1000 + 0.1);
      this.speedOverrideValue = cfg.speed;
    } else {
      this.extraSpeed = 0;
      this.speedOverrideValue = Math.trunc(cfg.speed * (1 + cfg.accTableMilli[level] / 1000) + 0.1);
    }
    this.extraPower = cfg.powerTableRatio[level];
    this.replicating = true;
    this.updateNeeds();
    return true;
  }
}

/** What is left of an ingredient buffer after a craft took its share, and the proliferator level of what it took. */
export interface IncSplit {
  /** The level of the taken items: the points per item the craft runs at, before the cap of 10. */
  level: number;
  /** Items left. */
  left: number;
  /** Proliferator points left with them. */
  leftInc: number;
}

// mirrors: AssemblerComponent.InternalUpdate
/**
 * The game's `split_inc_level` step, which the decompile has inline at the start of a craft: take `take` of `count`
 * served items that hold `total` points between them (see the header for the port's reading). `avg = floor(total /
 * count)` points per item and `total - avg * count` items hold one more; of those, the ones beyond the `count - take`
 * items that stay go to the taken ones. The level is `avg`, one more if any of those extra points is taken. Call it
 * with `count >= take >= 1`.
 */
export function splitIncLevel(count: number, total: number, take: number): IncSplit {
  const avg = Math.floor(total / count);
  const left = count - take;
  const extra = total - avg * count - left;
  const removed = extra > 0 ? avg * take + extra : avg * take;
  return { level: extra > 0 ? avg + 1 : avg, left, leftInc: total - removed };
}

/** The most of a product (count `count` per craft) the buffer may hold before a finished craft is held back. */
function outputBlockAbove(cfg: MachineConfig, count: number): number {
  const caps = cfg.outputCaps;
  if (cfg.lab) return LAB_OUTPUT_PER_SPEED * Math.ceil(cfg.speed / TIME_UNIT) - count;
  if (cfg.recipeType === 'SMELT') return caps.SMELT_items - count;
  if (cfg.recipeType === 'ASSEMBLE') return (caps.ASSEMBLE_crafts - 1) * count;
  return (caps.OTHER_crafts - 1) * count;
}
