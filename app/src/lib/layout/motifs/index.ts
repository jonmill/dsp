// The motif library (Task 26): direct insertion, the shared-belt sandwich and lab stacking.
//
// Motifs pack machines tighter than generic placement and routing can, but they rest on game behaviour nobody has
// checked in game yet (sorter reach between two buildings, how a lab stack passes items on). So a motif is only used
// once it is in `VERIFIED_MOTIFS`, which ships empty, or when the user asks for the ones not yet verified
// (`SolveOptions.useUnverifiedMotifs`, the "Use dense motifs not yet verified in-game" option). The validator judges
// every layout that uses motifs exactly as it judges any other.
import type { GameDataIndex, TechEffects } from '../../data';
import type { Netlist } from '../netlist';
import { directInsertionMotif } from './direct-insertion';
import { labStackMotif } from './lab-stack';
import { sandwichMotif } from './sandwich';
import type { Motif, MotifInstance, MotifKind } from './types';

export { applyMotifs } from './apply';
export type { InternalSorter, Motif, MotifGroup, MotifInstance, MotifKind, MotifMember, NetlistMotifs } from './types';

/** In order of priority: when two motifs want the same machine, the earlier one gets it. */
export const MOTIFS: Motif[] = [labStackMotif, directInsertionMotif, sandwichMotif];

/** The motifs whose geometry and behaviour have been confirmed in game. Ships empty. */
export const VERIFIED_MOTIFS = new Set<MotifInstance['kind']>();

/** The kinds the solver may use: the verified ones, and every kind when the user opts in to the unverified. */
export function enabledMotifKinds(useUnverifiedMotifs: boolean, verified: ReadonlySet<MotifKind> = VERIFIED_MOTIFS): Set<MotifKind> {
  return new Set(useUnverifiedMotifs ? MOTIFS.map((m) => m.kind) : verified);
}

/**
 * The instances of the motifs in `kinds` for `net`, in priority order (see `MOTIFS`), no two sharing a machine: a
 * motif only gets the machines the motifs before it left.
 */
export function proposeMotifs(net: Netlist, data: GameDataIndex, effects: TechEffects, kinds: ReadonlySet<MotifKind>): MotifInstance[] {
  const taken = new Set<number>();
  const found: MotifInstance[] = [];
  for (const motif of MOTIFS) {
    if (!kinds.has(motif.kind)) continue;
    for (const instance of motif.propose(net, data, effects, taken)) {
      if (instance.machineIds.some((id) => taken.has(id))) continue;
      for (const id of instance.machineIds) taken.add(id);
      found.push(instance);
    }
  }
  return found;
}
