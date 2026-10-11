// Station belt ports (MX §7). A logistics station is a block box here: its output ports draw from an unlimited
// supply of the item their storage slot names, its input ports are an unlimited sink that counts what arrives.
// What the station stocks, drones and vessels are not simulated; the planner sized the slots, and the simulator's
// question is whether the belts, sorters and machines around the ports keep up.
import type { StationConfig } from '../../geometry';
import { MAX_CARGO_STACK } from './cargo';
import type { Cargo } from './cargo';
import type { BeltSim } from './belt';

/** A port acts at most this often (MX §7: `counter = 1`, so every second tick). */
const PORT_PERIOD = 2;

interface OutputPort {
  belt: BeltSim;
  /** Reused for every insert: the belt copies the fields. */
  cargo: Cargo;
  /** First tick this port may act again. */
  nextTick: number;
}

interface InputPort {
  belt: BeltSim;
  nextTick: number;
}

export class StationSim {
  /** Items per output cargo: `pilerCount`, or the researched stacking level when `pilerCount` is 0, never above it. */
  readonly outputStack: number;
  private readonly cfg: StationConfig;
  private readonly outputs: OutputPort[] = [];
  private readonly inputs: InputPort[] = [];
  /** Item ids of the configured slots: what an input port takes. */
  private readonly slotItems = new Set<number>();
  private readonly acceptItem = (item: number): boolean => this.slotItems.has(item);
  private readonly receivedItems = new Map<number, number>();
  private readonly emittedItems = new Map<number, number>();

  /** `pilerLevel` is `TechEffects.stationPilerLevel`. */
  constructor(cfg: StationConfig, pilerLevel: number) {
    this.cfg = cfg;
    const level = Math.min(Math.max(1, pilerLevel), MAX_CARGO_STACK);
    this.outputStack = cfg.pilerCount === 0 ? level : Math.min(cfg.pilerCount, level);
    for (const slot of cfg.slots) if (slot.itemId !== 0) this.slotItems.add(slot.itemId);
  }

  /**
   * Feed `belt`'s head from output port `port`. A port whose config `dir` is not 1 (output), or whose storage
   * slot is unset, never acts. The slot is `slots[storageIdx - 1]`; MX §7's warper index past the slots is not
   * modelled.
   */
  attachOutput(port: number, belt: BeltSim): void {
    const cfgPort = this.portConfig(port);
    if (cfgPort.dir !== 1) return;
    const item = cfgPort.storageIdx >= 1 ? (this.cfg.slots[cfgPort.storageIdx - 1]?.itemId ?? 0) : 0;
    if (item === 0) return;
    this.outputs.push({ belt, cargo: { item, stack: this.outputStack, inc: 0 }, nextTick: 0 });
  }

  /** Drain `belt`'s rear into input port `port`. A port whose config `dir` is not 2 (input) never acts. */
  attachInput(port: number, belt: BeltSim): void {
    if (this.portConfig(port).dir !== 2) return;
    this.inputs.push({ belt, nextTick: 0 });
  }

  /** Items that reached the input ports, for item id `itemId` (stack sizes summed). */
  received(itemId: number): number {
    return this.receivedItems.get(itemId) ?? 0;
  }

  /** Items the output ports have put onto belts, for item id `itemId` (stack sizes summed). */
  emitted(itemId: number): number {
    return this.emittedItems.get(itemId) ?? 0;
  }

  /** Input ports, then output ports; the world calls the two halves in their own phases instead. */
  tick(tickIndex: number): void {
    this.tickInput(tickIndex);
    this.tickOutput(tickIndex);
  }

  // mirrors: StationComponent.UpdateInputSlots
  /**
   * Each input port takes the cargo at the rear of its belt if the item matches a slot (an unlimited sink always
   * "needs" it, MX §7). A cargo of any other item stays and blocks the belt. Whole stacks are accepted.
   */
  tickInput(tickIndex: number): void {
    for (const port of this.inputs) {
      if (tickIndex < port.nextTick) continue;
      const c = port.belt.tryPickRear(0, this.acceptItem);
      if (c === null) continue;
      port.nextTick = tickIndex + PORT_PERIOD;
      this.receivedItems.set(c.item, (this.receivedItems.get(c.item) ?? 0) + c.stack);
    }
  }

  // mirrors: StationComponent.UpdateOutputSlots
  /** Each output port writes one cargo at the head of its belt if the first 10 cells are empty. */
  tickOutput(tickIndex: number): void {
    for (const port of this.outputs) {
      if (tickIndex < port.nextTick) continue;
      if (!port.belt.tryInsertAtHead(port.cargo)) continue;
      port.nextTick = tickIndex + PORT_PERIOD;
      const { item, stack } = port.cargo;
      this.emittedItems.set(item, (this.emittedItems.get(item) ?? 0) + stack);
    }
  }

  private portConfig(port: number) {
    const cfgPort = this.cfg.ports[port];
    if (!Number.isInteger(port) || cfgPort === undefined) {
      throw new RangeError(`station port ${port} outside 0..${this.cfg.ports.length - 1}`);
    }
    return cfgPort;
  }
}
