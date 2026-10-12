// Applying motif instances to a netlist (Task 26). The nets lose the taps the motifs take over, the machines of an
// instance become a rigid group for placement, and the instance's internal sorters are recorded for the tap
// assignment (which keeps their slots free) and the assembly (which writes them as sorters between buildings).
//  - `direct`: the taps of `satisfiesNets` leave their nets (the flows between them balance, so what stays is balanced
//    too); a net left with no taps is dropped.
//  - `labStack`: the taps of the upper labs move to the bottom lab, which becomes one tap with their summed rate and as
//    many sorters as that needs.
//  - `sandwich`: only the group; nothing leaves the nets.
// Net ids are renumbered from 1 afterwards (belt ids follow them). An instance that shares a machine with an earlier
// one is left out, so the order of `instances` is the order of priority.
import type { GameDataIndex, TechEffects } from '../../data';
import { netStack, sortersNeeded } from '../netlist';
import type { BeltNet, NetTap, Netlist } from '../netlist';
import type { InternalSorter, MotifGroup, MotifInstance } from './types';

/** Flows closer than this (relative) are the same. */
const BALANCE_EPS = 1e-6;

export function applyMotifs(base: Netlist, instances: readonly MotifInstance[], data: GameDataIndex, effects: TechEffects): Netlist {
  const nets: BeltNet[] = base.nets.map((n) => ({ ...n, taps: n.taps.map((t) => ({ ...t })) }));
  const netById = new Map(nets.map((n) => [n.id, n] as const));
  const machineIds = new Set(base.machines.map((m) => m.id));
  const used = new Set<number>();
  const groups: MotifGroup[] = [];
  const sorters: InternalSorter[] = [];

  for (const instance of instances) {
    if (instance.machineIds.some((id) => !machineIds.has(id))) {
      throw new Error(`applyMotifs: a ${instance.kind} instance names machine(s) the netlist does not have: ${instance.machineIds.join(', ')}`);
    }
    if (instance.machineIds.some((id) => used.has(id))) continue;
    for (const id of instance.machineIds) used.add(id);

    for (const sat of instance.satisfiesNets) {
      const net = netById.get(sat.netId);
      if (!net) throw new Error(`applyMotifs: a ${instance.kind} instance names net ${sat.netId}, which the netlist does not have`);
      if (instance.kind === 'labStack') mergeIntoLeader(net, sat.machineIds, instance.machineIds[0], base, data, effects);
      else removeTaps(net, sat.machineIds, instance.kind);
    }
    for (const s of instance.internalSorters) sorters.push({ ...s });
    groups.push({ kind: instance.kind, members: instance.relative.map((r) => ({ ...r })) });
  }

  // drop the nets that have no taps left (the proliferator net never has any: it stays), number the rest from 1
  const kept = nets.filter((n) => n.taps.length > 0 || n.proliferator).map((n, i) => ({ ...n, id: i + 1 }));
  return { ...base, nets: kept, warnings: [...base.warnings], motifs: { groups, sorters } };
}

/** Takes the taps of `ids` off `net`; the producers' and the consumers' rates taken have to balance. */
function removeTaps(net: BeltNet, ids: readonly number[], kind: string): void {
  const gone = net.taps.filter((t) => ids.includes(t.machineId));
  const sum = (dir: NetTap['dir']): number => gone.filter((t) => t.dir === dir).reduce((s, t) => s + t.rate, 0);
  const out = sum('out');
  const into = sum('in');
  if (Math.abs(out - into) > BALANCE_EPS * Math.max(1, out, into)) {
    throw new Error(`applyMotifs: a ${kind} instance takes ${out}/s off net ${net.id} but ${into}/s into its machines: the flows do not balance`);
  }
  net.taps = net.taps.filter((t) => !ids.includes(t.machineId));
  if (net.source.kind === 'taps') net.rate = Math.max(0, net.rate - out);
}

/** The taps of `uppers` on `net` become the leader's, merged with its own for the same item and direction. */
function mergeIntoLeader(
  net: BeltNet,
  uppers: readonly number[],
  leader: number,
  base: Netlist,
  data: GameDataIndex,
  effects: TechEffects,
): void {
  const merged: NetTap[] = [];
  for (const t of net.taps) {
    const machineId = uppers.includes(t.machineId) ? leader : t.machineId;
    const same = merged.find((m) => m.machineId === machineId && m.itemId === t.itemId && m.dir === t.dir);
    if (same) same.rate += t.rate;
    else merged.push({ ...t, machineId });
  }
  const stack = netStack(net.source.kind === 'station', effects);
  for (const t of merged) t.sorters = sortersNeeded(t.rate, base.sorterTierItemId, 1, t.dir === 'in' ? stack : 0, effects, data);
  // producers first, then consumers, each in machine id order
  merged.sort((a, b) => (a.dir === b.dir ? a.machineId - b.machineId : a.dir === 'out' ? -1 : 1));
  net.taps = merged;
}
