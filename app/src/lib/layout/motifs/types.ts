// What a motif is (Task 26): a recipe for packing several machines of a netlist tighter than generic placement and
// routing would. A motif proposes `MotifInstance`s for a netlist; `applyMotifs` (index.ts) turns chosen instances into
// a netlist with `Netlist.motifs`, which placement keeps as rigid groups, the tap assignment leaves the internal
// sorters' slots to, and `assembleLayout` writes out as building-to-building sorters and stacked buildings.
import type { GameDataIndex, TechEffects } from '../../data';
import type { Yaw } from '../../geometry';
import type { Netlist } from '../netlist';

export type MotifKind = 'direct' | 'sandwich' | 'labStack';

export interface MotifInstance {
  kind: MotifKind;
  /** Netlist machine ids; the first is the anchor machine. */
  machineIds: number[];
  /** Where the anchor stands in the motif's own frame. Proposals put it at the origin, yaw 0. */
  anchor: { x: number; y: number; yaw: Yaw };
  /**
   * Every machine of the motif relative to the anchor (the anchor itself at 0, 0, 0, yaw 0): grid tiles east and north
   * of the anchor's position when the anchor has yaw 0, levels above it, and the yaw the machine has when the anchor has
   * yaw 0 (a group turned by a quarter turn keeps these relative to the anchor's yaw). `onTop` is the machine a lab
   * stands on.
   */
  relative: { machineId: number; dx: number; dy: number; dz: number; yaw: Yaw; onTop?: number }[];
  /**
   * Sorters between the motif's own machines, which replace belts. `plannedRate` is the share of the item's flow this
   * sorter carries, in items/s; the sorters of one flow add up to it.
   */
  internalSorters: {
    fromMachine: number;
    fromSlot: number;
    toMachine: number;
    toSlot: number;
    itemId: number;
    span: 1 | 2 | 3;
    plannedRate: number;
  }[];
  /**
   * The nets the motif takes off the belts, with the machines whose taps on them it replaces: for `direct` the taps of
   * these machines on that net are removed (the flows between them balance, so the rest of the net is untouched); for
   * `labStack` the taps of these upper labs are carried by the stack's bottom lab instead.
   */
  satisfiesNets: { netId: number; machineIds: number[] }[];
}

export interface Motif {
  kind: MotifKind;
  /**
   * The instances this motif can make of `net`. `taken` are machines that earlier motifs already claimed: none of the
   * instances may use one. Instances of one motif do not share machines.
   */
  propose(net: Netlist, data: GameDataIndex, effects: TechEffects, taken?: ReadonlySet<number>): MotifInstance[];
}

// ---------------------------------------------------------------------------------------------
// What a netlist carries once motifs are applied (`Netlist.motifs`)

/** A machine of a group, placed relative to the group's leader (see `MotifInstance.relative`). */
export interface MotifMember {
  machineId: number;
  dx: number;
  dy: number;
  dz: number;
  yaw: Yaw;
  /** The machine this one stands on: its building gets that machine's building as `stackParentId`. */
  onTop?: number;
}

/** Machines that move and turn as one: the leader is `members[0]`. */
export interface MotifGroup {
  kind: MotifKind;
  members: MotifMember[];
}

/** A sorter between two machines of a group: replaces the belt for part of a flow. */
export interface InternalSorter {
  fromMachine: number;
  fromSlot: number;
  toMachine: number;
  toSlot: number;
  itemId: number;
  span: 1 | 2 | 3;
  plannedRate: number;
}

export interface NetlistMotifs {
  groups: MotifGroup[];
  sorters: InternalSorter[];
}
