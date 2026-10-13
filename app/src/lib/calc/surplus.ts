// Surplus sinks: which made-and-used items need a station port at the end of their belt for what the machines can make
// beyond what is used (Task 30b).
//
// The plan balances every item exactly: what the stages make is what the stages use plus what is exported. The machines are
// rounded up, though (`machinesFor`), and a machine runs at full speed whenever it can: a producer of an item makes up to
// `1 / utilization` of its planned output, so the belt of an item that nothing drains fills, and its producers block. A producer
// that only makes that item blocks harmlessly. Several producers on one belt do not: whichever finds gaps first fills the belt,
// the others block, and what they make besides never comes out. Deuteron Fuel Rod: hydrogen from Plasma Refining (which also
// makes the oil the sulfuric acid, the titanium alloy and so the fuel rods need) and from Graphene (advanced), 4 % over its
// plan, which filled the belt in the minutes before the chain had started to use any; Plasma Refining blocked on its hydrogen, the
// oil stopped, no fuel rod was made and no hydrogen was used, for good (SIM_DEADLOCK at four of the six rungs). The cure is a
// way out for the surplus: the belt ends at a station port (an export slot), as the belt of a by-product nothing uses does
// (Review Focus 4). Items that are imported as well or exported already have one (their nets end at a station), and an item with
// no spare capacity has no surplus.
//
// Not for a lone producer that makes another item as well (the loop through the producer: its belt fills, it blocks, the other item
// stops, and the consumers that would have drained the belt wait for it). That is a deadlock on paper, and none of the sweeps' failures is
// one; a sink there costs more than it saves: the consumers then pick from a stream that passes them instead of a
// pile at the end of the belt, and a consumer with little spare capacity (Casimir Crystal, one machine of 0.85) catches 70 % of what
// passes and starves its chain (Plane Filter with Mk.III proliferator: from the first rung to the fifth).
import type { Flow, ItemRate, Stage } from './types';

const EPS = 1e-9;

/** What `surplusSinks` needs of a stage. */
export type SurplusStage = Pick<Stage, 'machines' | 'exactMachines' | 'outputs'>;

/**
 * The items that several stages make and use, whose belts need a station port for a surplus, each with the rate its producers' spare machine capacity can add
 * (`outputs / utilization - outputs`, summed over its producers), in item id order. `importIds` and `exportIds` are the items
 * that have a station on their belts already. `flows` are the plan's: `from` and `to` are indexes into `stages`.
 */
export function surplusSinks(
  stages: readonly SurplusStage[],
  flows: readonly Flow[],
  importIds: ReadonlySet<number>,
  exportIds: ReadonlySet<number>,
): ItemRate[] {
  // item -> the stages that make it and the stages that use it, from the flows between stages
  const producers = new Map<number, Set<number>>();
  const add = (map: Map<number, Set<number>>, key: number, value: number): void => {
    const set = map.get(key) ?? new Set<number>();
    set.add(value);
    map.set(key, set);
  };
  for (const flow of flows) {
    if (flow.perSecond <= EPS || flow.from === 'import' || flow.to === 'export') continue;
    add(producers, flow.itemId, flow.from);
  }

  const sinks: ItemRate[] = [];
  for (const itemId of [...producers.keys()].sort((a, b) => a - b)) {
    if (importIds.has(itemId) || exportIds.has(itemId)) continue;
    const makers = producers.get(itemId) as Set<number>;
    if (makers.size < 2) continue;
    let spare = 0;
    for (const s of makers) {
      const stage = stages[s];
      const made = stage.outputs.find((o) => o.itemId === itemId)?.perSecond ?? 0;
      spare += made * (stage.machines / stage.exactMachines - 1);
    }
    if (spare > EPS) sinks.push({ itemId, perSecond: spare });
  }
  return sinks;
}
