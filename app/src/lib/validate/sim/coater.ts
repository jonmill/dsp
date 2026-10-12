// Spray coater simulation (`SpraycoaterComponent`, MX §4.6). A coater sits on an item belt and has a proliferator
// belt at its top passage. It takes proliferator cargo from the proliferator belt into a store of sprays (one type
// at a time, up to a capacity) and raises the proliferator points of the item cargo passing it.
//
// What this port settles where MX §4.6 is open:
//  - Intake looks for proliferator in a 5-cell window around the coater's cell on the proliferator belt, like a
//    sorter's belt pick, and takes it while the store is below its capacity: a cargo may overshoot the capacity by
//    less than one cargo. A proliferator of another type, or any other item, stays on the belt.
//  - The cargo being sprayed is the one whose 10 cells cover the coater's cell on the item belt (`BeltSim.cargoAt`).
//  - Pacing: `sprayTime` grows by `beltSpeed · 1000 · power` per tick, so one cargo per 10000 keeps up with a belt
//    of cargo packed head to tail. Time is banked up to one spray, so a coater never bursts after idling.
//  - It works (draws work power) while a cargo it could spray, with enough sprays left, is in front of it.
import type { Building, GameDataIndex } from '../../data';
import type { Cargo } from './cargo';
import type { BeltRef } from './sorter';

/** Below this serve ratio the coater does nothing (MX §4.6). */
const MIN_POWER = 0.1;
/** One cargo is sprayed per this much `sprayTime`. */
const SPRAY_UNIT = 10000;
/** `sprayTime` per tick per belt cell of speed at full power. */
const SPRAY_RATE_PER_SPEED = 1000;
/** The cargo tables have entries 0..10. */
const MAX_INC_LEVEL = 10;

/** What one proliferator item is worth. */
export interface ProliferatorInfo {
  /** Points per item a sprayed cargo gets. */
  ability: number;
  /** Sprays one item adds (`hpMax`), before the bonus for a proliferator that was itself sprayed. */
  sprays: number;
}

export interface CoaterConfig {
  /** The belt being sprayed, at the cell the coater sits on. */
  item: BeltRef;
  /** The proliferator belt, at the cell its top passage reads from. */
  prolif: BeltRef;
  /** Sprays the store holds. */
  incCapacity: number;
  /** Proliferator items the coater accepts. */
  proliferators: ReadonlyMap<number, ProliferatorInfo>;
  /** `GameData.constants.incTableMilli`: the bonus sprays of a sprayed proliferator. */
  incTableMilli: readonly number[];
}

/**
 * The config of spray coater `def` between `item` and `prolif`. Throws, naming the building, if it is not a coater
 * or an item it lists is not a proliferator.
 */
export function coaterConfig(def: Building, item: BeltRef, prolif: BeltRef, data: GameDataIndex): CoaterConfig {
  const coater = def.sprayCoater;
  if (!coater) throw new Error(`building ${def.itemId} (${def.name}) is not a spray coater`);
  const proliferators = new Map<number, ProliferatorInfo>();
  for (const id of coater.incItemIds) {
    const p = data.item(id).proliferator;
    if (!p) throw new Error(`item ${id} listed by ${def.name} is not a proliferator`);
    proliferators.set(id, { ability: p.ability, sprays: p.sprays });
  }
  return {
    item,
    prolif,
    incCapacity: coater.incCapacity,
    proliferators,
    incTableMilli: data.data.constants.incTableMilli,
  };
}

export class CoaterSim {
  /** Cargo sprayed so far. */
  sprayedCargo = 0;
  /** Items (the stacks of that cargo added up) sprayed so far. */
  sprayedItems = 0;
  /** Proliferator items taken from the proliferator belt so far. */
  proliferatorTaken = 0;

  private readonly cfg: CoaterConfig;
  private readonly accept: (item: number) => boolean;
  private readonly scratch: Cargo = { item: 0, stack: 1, inc: 0 };
  /** Sprays in store. */
  private store = 0;
  /** The proliferator item the store holds: 0 when empty. */
  private storeItem = 0;
  private sprayTime = SPRAY_UNIT;
  private working = false;

  constructor(cfg: CoaterConfig) {
    this.cfg = cfg;
    this.accept = (item) => cfg.proliferators.has(item) && (this.storeItem === 0 || item === this.storeItem);
  }

  /** Sprays in store. */
  get sprays(): number {
    return this.store;
  }

  /** Whether the coater draws work power this tick rather than idle power. */
  workingThisTick(): boolean {
    return this.working;
  }

  // mirrors: SpraycoaterComponent.InternalUpdate
  /** One tick at serve ratio `power`: take proliferator in if there is room, then spray the cargo in front. */
  tick(power: number): void {
    this.working = false;
    if (!(power >= MIN_POWER)) return;
    const cfg = this.cfg;
    if (this.store < cfg.incCapacity) this.takeProliferator();

    this.sprayTime = Math.min(SPRAY_UNIT, this.sprayTime + Math.trunc(cfg.item.belt.speed * SPRAY_RATE_PER_SPEED * power));
    if (this.store <= 0) return;
    const cargo = this.scratch;
    if (!cfg.item.belt.cargoAt(cfg.item.cell, cargo)) return;
    const ability = cfg.proliferators.get(this.storeItem)!.ability;
    const target = cargo.stack * ability;
    if (cargo.inc >= target || this.store < cargo.stack) return; // nothing to raise, or too few sprays left
    this.working = true;
    if (this.sprayTime < SPRAY_UNIT) return;
    cfg.item.belt.setIncAt(cfg.item.cell, target);
    this.sprayTime -= SPRAY_UNIT;
    this.store -= cargo.stack;
    this.sprayedCargo++;
    this.sprayedItems += cargo.stack;
    if (this.store === 0) this.storeItem = 0;
  }

  /**
   * Pick one proliferator cargo from the proliferator belt. Each item adds its `sprays`, plus, if the item was
   * itself sprayed, `int(sprays · incTable[points per item] / 1000 + 0.1)` (MX §4.6, §5).
   */
  private takeProliferator(): void {
    const cfg = this.cfg;
    const c = cfg.prolif.belt.tryPick(cfg.prolif.cell, 0, this.accept);
    if (c === null) return;
    const info = cfg.proliferators.get(c.item)!;
    const level = Math.min(Math.floor(c.inc / c.stack), MAX_INC_LEVEL);
    const bonus = Math.trunc((info.sprays * cfg.incTableMilli[level]) / 1000 + 0.1);
    this.store += c.stack * (info.sprays + bonus);
    this.storeItem = c.item;
    this.proliferatorTaken += c.stack;
  }
}
