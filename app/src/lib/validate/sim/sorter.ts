// Sorter simulation: the state machine of `InserterComponent.InternalUpdate` (MX §3.2, §3.3).
//
// A sorter cycles Picking -> Sending -> Inserting -> Returning. Each stage that takes time adds `power · 10000` to
// a counter every tick and leaves when it reaches `stt`, so a round trip is `2 · stt / 10000` ticks at full power;
// the pick tick is the first Sending tick and the insert tick the first Returning tick. A sorter picks from a belt
// cell (`BeltSim.tryPick`) or from a building (`PickSource`: products only, one item per pick) and drops onto a belt
// cell (`BeltSim.tryInsert`) or into a building (`InsertTarget`). Building models live in machine.ts and implement
// the two interfaces here, so this file knows nothing about assemblers.
//
// What this port settles where MX §3.2 is open:
//  - One stage per tick. A tick that ends a stage does no work of the next one, which gives the cycle times the
//    spec states (Mk.I 40 ticks, Mk.III 10, pile 6).
//  - "Target needs all zero" is `!InsertTarget.needsAny()` when the target offers it (the game's `needs[]` array,
//    all zero). A target without it can only answer per item through `needs(item)`: picking with a filter then asks
//    for that item, picking with no filter cannot tell (no back-off; the `needs` filter on the pick rejects unwanted
//    items), and inserting asks for the held item. That fallback can deadlock a stacking sorter on a mixed belt
//    (it holds three of an item the target stopped needing while the target waits for another), so building
//    models should implement `needsAny`.
//  - Inserting hands the target `itemCount / stackCount` items per tick and repeats until nothing is held (a
//    non-pile sorter has one stack, so one insertion of the whole cargo; a pile sorter with `StackOutput = 1` thus
//    unstacks onto a belt, one item per tick, which MX §3.4 says an un-upgraded pile sorter does). With
//    `StackOutput > 1` and a belt target it builds cargo of up to `StackOutput` items, always as new cargo:
//    topping up a cargo already near the drop point (`TryInsertItemWithStackIncreasement`) is not modelled.
//  - A belt pick cell is clamped into `[4, length - 6]` (MX §3.3); a drop cell is used as given.
//  - Work power is drawn while the sorter ends the tick in Sending or Returning (`workingThisTick`).
//  - The "item vanished while Sending" branch of MX §3.2 is not ported: nothing in the simulator removes a held item.
import type { Building, TechEffects } from '../../data';
import type { BeltSim } from './belt';
import { MAX_CARGO_STACK } from './cargo';
import type { Cargo } from './cargo';

/** A belt cell a sorter picks from or drops onto: where its end sits on the belt (see `World.beltCell`). */
export interface BeltRef {
  belt: BeltSim;
  cell: number;
}

/** What a sorter drops into: a building. Implemented by `MachineSim` (Task 19). */
export interface InsertTarget {
  /** Whether the building wants `item` now (its ingredient buffer is below the threshold of MX §4.3). */
  needs(item: number): boolean;
  /** True if the sorter must only pick what `needs` allows (assemblers, labs, ...). */
  careNeeds: boolean;
  /**
   * Whether the building needs any item at all (the game's `needs[]` is not all zero). Gates the Picking back-off and
   * the Inserting wait. Without it the sorter falls back to `needs(item)` for one item, which can deadlock a stacking
   * sorter on a mixed belt.
   */
  needsAny?(): boolean;
  /** Add `count` items of `item` carrying `inc` proliferator points. False if the building refuses them. */
  insert(item: number, count: number, inc: number): boolean;
}

/** What a sorter picks from: a building's products. Implemented by `MachineSim` (Task 19). */
export interface PickSource {
  /**
   * Take one product item of kind `filter` (0 = any) that `accept` allows, or null if there is none. Ingredients are
   * never offered (MX §3.3).
   */
  pickProduct(filter: number, accept: (item: number) => boolean): { item: number; count: number; inc: number } | null;
}

/** Timing and stacking of one sorter, from its prefab, span and the researched upgrades: see `sorterSettings`. */
export interface SorterSettings {
  /** 1 to 4: Mk.I, Mk.II, Mk.III, pile sorter. */
  grade: number;
  /** One leg of the trip, in 1/10000 ticks at full power. */
  stt: number;
  /** Ticks (in 1/10000) after the last successful pick before a sorter that holds something leaves anyway. */
  delay: number;
  /** Most pick operations a trip collects. */
  stackInput: number;
  /** Most items per cargo a pile sorter builds on a belt; 1 unstacks. */
  stackOutput: number;
}

export interface SorterConfig extends SorterSettings {
  pick: BeltRef | PickSource;
  drop: BeltRef | InsertTarget;
  /** Item to pick (0 = any). */
  filter: number;
}

/** `InserterComponent.speed`: the per-tick progress of a stage at full power. */
const SPEED = 10000;
/** Below this serve ratio sorters do nothing (MX §3.2). */
const MIN_POWER = 0.1;
/** A leg takes at least one tick (MX §3.1). */
const MIN_STT = 10000;
const PILE_SORTER_GRADE = 4;
/** `Delay` of a pile sorter that stacks (MX §3.2 grade table). */
const PILE_DELAY = 40000;
/** `idleTick` after a Picking sorter that holds nothing finds the target needs nothing. */
const IDLE_EMPTY = 9;
/** `idleTick` after a Picking sorter that holds something, or an Inserting sorter, finds the target needs nothing. */
const IDLE_HOLDING = 10;
/** A belt end is attached at a cell in `[4, length - 6]` (MX §3.3). */
const MIN_CELL = 4;
const END_MARGIN = 6;

const PICKING = 0;
const SENDING = 1;
const INSERTING = 2;
const RETURNING = 3;

export type SorterStage = 'picking' | 'sending' | 'inserting' | 'returning';
const STAGE_NAMES: readonly SorterStage[] = ['picking', 'sending', 'inserting', 'returning'];

const ACCEPT_ALL = (): boolean => true;

/**
 * Timing and stacking for sorter `sorter` placed at `span` grid lengths (1 to 3) under the tech state `effects`.
 *
 * `stt = max(10000, prefab.stt · span)` for every grade, the pile sorter included. That is a ruling, not a
 * measurement: BF/CYING claim the pile sorter's speed does not depend on length, which is unverified (MX §3.1, C3),
 * while the wiki's player-measured pile table falls with distance. Scaling is the conservative choice, and with a
 * dense belt it reproduces that table (800 / 480 / 343 items/min at span 1 / 2 / 3). `sorterRate` in capacity.ts
 * makes the same choice. Grades 1 to 3 pick and drop one cargo (Mk.III's `inserterStackCountObsolete` is 1 in new
 * saves, so no Delay). The pile sorter loads `inserterStackInput` (at most a cargo, 4), feeds out
 * `inserterStackOutput`, and waits 40000 for more when it loads more than one (MX §3.2).
 */
export function sorterSettings(sorter: NonNullable<Building['sorter']>, span: number, effects: TechEffects): SorterSettings {
  const pile = sorter.grade === PILE_SORTER_GRADE;
  const stt = Math.max(MIN_STT, sorter.stt * span);
  if (!pile) return { grade: sorter.grade, stt, delay: sorter.delay, stackInput: 1, stackOutput: 1 };
  const stackInput = Math.min(Math.max(1, effects.inserterStackInput), MAX_CARGO_STACK);
  return {
    grade: sorter.grade,
    stt,
    delay: stackInput > 1 ? PILE_DELAY : sorter.delay,
    stackInput,
    stackOutput: Math.min(Math.max(1, effects.inserterStackOutput), MAX_CARGO_STACK),
  };
}

const isBeltRef = (end: BeltRef | PickSource | InsertTarget): end is BeltRef => 'belt' in end;

function checkInt(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) throw new RangeError(`sorter ${name} ${value} must be an integer of at least ${min}`);
}

/** The cell a sorter attaches to on `ref.belt`, validated; with `clamp`, pulled into `[4, length - 6]`. */
function attachCell(ref: BeltRef, clamp: boolean): number {
  const { belt, cell } = ref;
  if (!Number.isInteger(cell) || cell < 0 || cell >= belt.length) {
    throw new RangeError(`sorter cell ${cell} outside the belt (0..${belt.length - 1})`);
  }
  const max = belt.length - END_MARGIN;
  return clamp && max >= MIN_CELL ? Math.min(Math.max(cell, MIN_CELL), max) : cell;
}

export class SorterSim {
  readonly grade: number;
  readonly filter: number;
  readonly stt: number;
  readonly delay: number;
  readonly stackInput: number;
  readonly stackOutput: number;

  private readonly pickBelt: BeltRef | null;
  private readonly pickCell: number;
  private readonly pickSource: PickSource | null;
  private readonly dropBelt: BeltRef | null;
  private readonly dropCell: number;
  private readonly dropTarget: InsertTarget | null;
  /** True if the drop is a building that only wants some items: picking is limited to what it needs. */
  private readonly careNeeds: boolean;
  /** Passed to the picker: items the target needs, or everything. */
  private readonly accept: (item: number) => boolean;
  /** Reused for belt inserts: the belt copies the fields. */
  private readonly scratch: Cargo = { item: 0, stack: 1, inc: 0 };

  private stageNo = PICKING;
  private time = 0;
  private idleTick = 0;
  private itemId = 0;
  private itemCount = 0;
  private itemInc = 0;
  private stackCount = 0;
  private moved = 0;

  constructor(cfg: SorterConfig) {
    checkInt('stt', cfg.stt, 1);
    checkInt('delay', cfg.delay, 0);
    checkInt('stackInput', cfg.stackInput, 1);
    checkInt('stackOutput', cfg.stackOutput, 1);
    checkInt('filter', cfg.filter, 0);
    this.grade = cfg.grade;
    this.filter = cfg.filter;
    this.stt = cfg.stt;
    this.delay = cfg.delay;
    this.stackInput = cfg.stackInput;
    this.stackOutput = cfg.stackOutput;

    if (isBeltRef(cfg.pick)) {
      this.pickBelt = cfg.pick;
      this.pickCell = attachCell(cfg.pick, true);
      this.pickSource = null;
    } else {
      this.pickBelt = null;
      this.pickCell = 0;
      this.pickSource = cfg.pick;
    }
    if (isBeltRef(cfg.drop)) {
      this.dropBelt = cfg.drop;
      this.dropCell = attachCell(cfg.drop, false);
      this.dropTarget = null;
      this.careNeeds = false;
      this.accept = ACCEPT_ALL;
    } else {
      this.dropBelt = null;
      this.dropCell = 0;
      const target = cfg.drop;
      this.dropTarget = target;
      this.careNeeds = target.careNeeds;
      this.accept = target.careNeeds ? (item) => target.needs(item) : ACCEPT_ALL;
    }
  }

  /** The stage the sorter is in now. */
  get stage(): SorterStage {
    return STAGE_NAMES[this.stageNo];
  }

  /** Items delivered to the drop so far. */
  get itemsMoved(): number {
    return this.moved;
  }

  // mirrors: InserterComponent.InternalUpdate
  /**
   * One tick at serve ratio `power` (MX §3.2). Below 10 % power the sorter does nothing; above it every stage
   * advances by `power · 10000` per tick.
   */
  tick(power: number): void {
    if (!(power >= MIN_POWER)) return;
    const step = Math.trunc(power * SPEED);
    switch (this.stageNo) {
      case PICKING:
        this.tickPicking(step);
        break;
      case SENDING:
        this.time += step;
        if (this.time >= this.stt) {
          this.stageNo = INSERTING;
          this.time -= this.stt;
        }
        break;
      case INSERTING:
        this.tickInserting(step);
        break;
      default:
        this.time += step;
        if (this.time >= this.stt) {
          this.stageNo = PICKING;
          this.time = 0;
        }
    }
  }

  /**
   * Whether the sorter draws work power this tick rather than idle power: it is Sending or Returning at the end of
   * the tick (MX §3.1). The pick tick and the insert tick count as work, the last tick of each leg does not.
   */
  workingThisTick(): boolean {
    return this.stageNo === SENDING || this.stageNo === RETURNING;
  }

  /**
   * The "target.needs all zero" test of MX §3.2: `needsAny` says so directly; without it, `item` (0 = unknown, never
   * a reason to wait) is the only thing that can be asked about.
   */
  private needsNothing(item: number): boolean {
    const target = this.dropTarget!;
    if (target.needsAny) return !target.needsAny();
    return item !== 0 && !target.needs(item);
  }

  private tickPicking(step: number): void {
    let filter: number;
    if (this.itemId === 0) {
      if (this.careNeeds) {
        if (this.idleTick > 0) {
          this.idleTick--;
          return;
        }
        if (this.needsNothing(this.filter)) {
          this.idleTick = IDLE_EMPTY;
          return;
        }
      }
      filter = this.filter;
    } else if (this.stackCount < this.stackInput) {
      if (this.careNeeds) {
        if (this.idleTick > 0) {
          this.idleTick--;
          return;
        }
        if (this.needsNothing(this.itemId)) {
          this.idleTick = IDLE_HOLDING;
          return;
        }
      }
      filter = this.itemId;
    } else {
      return; // full: the pick that filled it already moved the sorter to Sending
    }

    let item = 0;
    let count = 0;
    let inc = 0;
    if (this.pickBelt !== null) {
      const c = this.pickBelt.belt.tryPick(this.pickCell, filter, this.careNeeds ? this.accept : undefined);
      if (c !== null) {
        item = c.item;
        count = c.stack;
        inc = c.inc;
      }
    } else {
      const p = this.pickSource!.pickProduct(filter, this.accept);
      if (p !== null) {
        item = p.item;
        count = p.count;
        inc = p.inc;
      }
    }
    if (item !== 0) {
      this.itemId = item;
      this.itemCount += count;
      this.itemInc += inc;
      this.stackCount++;
      this.time = 0;
    }
    if (this.itemId !== 0) {
      this.time += SPEED;
      if (this.stackCount >= this.stackInput || this.time >= this.delay) {
        this.time = step;
        this.stageNo = SENDING;
      }
    } else {
      this.time = 0;
    }
  }

  private tickInserting(step: number): void {
    if (this.careNeeds && this.needsNothing(this.itemId)) {
      this.idleTick = IDLE_HOLDING;
      return;
    }
    const count = this.itemCount;
    const inc = this.itemInc;
    let n: number;
    let nInc: number;
    const builds = this.dropBelt !== null && this.stackOutput > 1;
    if (builds) {
      n = Math.min(this.stackOutput, count);
      nInc = n === count ? inc : Math.floor((inc * n) / count);
    } else {
      n = Math.floor(count / this.stackCount);
      nInc = Math.floor(inc / this.stackCount);
    }
    let ok: boolean;
    if (this.dropBelt !== null) {
      const cargo = this.scratch;
      cargo.item = this.itemId;
      cargo.stack = n;
      cargo.inc = nInc;
      ok = this.dropBelt.belt.tryInsert(this.dropCell, cargo);
    } else {
      ok = this.dropTarget!.insert(this.itemId, n, nInc);
    }
    if (!ok) return;
    this.moved += n;
    this.itemCount = count - n;
    this.itemInc = inc - nInc;
    if (!builds) this.stackCount--;
    if (this.itemCount === 0) {
      this.itemId = 0;
      this.itemInc = 0;
      this.stackCount = 0;
      this.stageNo = RETURNING;
      this.time += step;
    }
  }
}
