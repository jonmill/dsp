// Lab stacking (MX §4.4, §8, §9 M4): labs of one recipe stand on each other, up to `effects.labLevel` high, on one
// footprint. Ingredients climb and products come down inside the stack, so only the bottom lab gets sorters: its taps
// carry what the whole stack takes and makes.
//
// What is proposed. The Matrix Labs of a stage (same building, same recipe) in machine id order are cut into stacks
// as high as they may be and as even as they can be: 7 labs at labLevel 3 are 3, 2 and 2 high. A stack may not ask the
// bottom lab for more sorters than fit beside it: each of its taps (the stack's rate on a net, at span 1) at most
// `MAX_SORTERS_PER_TAP` sorters, and all of them together at most the lab's slots; otherwise the stacks are one lab
// lower. The bottom lab is the anchor; the others stand on the one below at `lapJoint / LEVEL` levels each.
//
// Power. The layout powers a stack as it powers any building: by its x and y, which every lab of the stack shares, so a
// tower that covers the bottom lab covers all of them. That rests on the range being 2D in game (as the validator
// assumes); it is an unverified assumption, and a tall stack could exceed a tower's vertical reach.
import type { Building, GameDataIndex, TechEffects } from '../../data';
import { LEVEL } from '../../geometry';
import { MAX_SORTERS_PER_TAP, netStack, sortersNeeded } from '../netlist';
import type { Netlist } from '../netlist';
import type { Motif, MotifInstance } from './types';

/** A lab can be stacked: it is a lab that is multiLevel, has a lapJoint and takes no sorters above the bottom level. */
function stackable(def: Building | undefined): def is Building {
  return !!def && def.kind === 'lab' && def.geometry.multiLevel && def.geometry.lapJoint[1] > 0 && !def.geometry.multiLevelAllowInserter;
}

/** `count` labs as `stacks` stacks, the higher ones first: sizes differ by at most one. */
function evenSizes(count: number, stacks: number): number[] {
  const base = Math.floor(count / stacks);
  const extra = count % stacks;
  return Array.from({ length: stacks }, (_, i) => base + (i < extra ? 1 : 0));
}

export const labStackMotif: Motif = {
  kind: 'labStack',
  propose(net: Netlist, data: GameDataIndex, effects: TechEffects, taken: ReadonlySet<number> = new Set()): MotifInstance[] {
    // the labs by (building, recipe), each in machine id order
    const groups = new Map<string, number[]>();
    for (const m of net.machines) {
      if (taken.has(m.id) || !stackable(data.building(m.buildingItemId))) continue;
      const key = `${m.buildingItemId}/${m.recipeId}`;
      const list = groups.get(key);
      if (list) list.push(m.id);
      else groups.set(key, [m.id]);
    }

    /** Does a stack of these labs fit its sorters on the bottom lab? */
    const fits = (ids: number[], def: Building): boolean => {
      const merged = new Map<string, { rate: number; fromBelt: number }>();
      for (const n of net.nets) {
        const fromBelt = netStack(n.source.kind === 'station', effects);
        for (const t of n.taps) {
          if (!ids.includes(t.machineId)) continue;
          const key = `${n.id}/${t.itemId}/${t.dir}`;
          const entry = merged.get(key) ?? { rate: 0, fromBelt: t.dir === 'in' ? fromBelt : 0 };
          entry.rate += t.rate;
          merged.set(key, entry);
        }
      }
      let total = 0;
      for (const { rate, fromBelt } of merged.values()) {
        const sorters = sortersNeeded(rate, net.sorterTierItemId, 1, fromBelt, effects, data);
        if (sorters > MAX_SORTERS_PER_TAP) return false;
        total += sorters;
      }
      return total <= def.geometry.slots.length;
    };

    const found: MotifInstance[] = [];
    for (const [key, ids] of groups) {
      const def = data.building(Number(key.split('/')[0])) as Building;
      const lapLevels = Math.round(def.geometry.lapJoint[1] / LEVEL);
      if (lapLevels < 1 || Math.abs(lapLevels * LEVEL - def.geometry.lapJoint[1]) > 0.05) continue;
      for (let height = Math.min(effects.labLevel, ids.length); height >= 2; height--) {
        const sizes = evenSizes(ids.length, Math.ceil(ids.length / height));
        let at = 0;
        const chunks = sizes.map((size) => ids.slice(at, (at += size)));
        if (!chunks.every((chunk) => chunk.length < 2 || fits(chunk, def))) continue;
        for (const chunk of chunks) {
          if (chunk.length < 2) continue;
          const uppers = chunk.slice(1);
          found.push({
            kind: 'labStack',
            machineIds: chunk,
            anchor: { x: 0, y: 0, yaw: 0 },
            relative: chunk.map((machineId, i) => ({
              machineId,
              dx: 0,
              dy: 0,
              dz: i * lapLevels,
              yaw: 0,
              ...(i > 0 ? { onTop: chunk[i - 1] } : {}),
            })),
            internalSorters: [],
            satisfiesNets: net.nets
              .map((n) => ({ netId: n.id, machineIds: uppers.filter((id) => n.taps.some((t) => t.machineId === id)) }))
              .filter((s) => s.machineIds.length > 0),
          });
        }
        break;
      }
    }
    return found;
  },
};
