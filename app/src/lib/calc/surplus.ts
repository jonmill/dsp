// Surplus sinks: candidates, which belts of made-and-used items could end at a station port for what the machines can make
// beyond what is used. They are used only when validation finds a deadlock (Task 30b).
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
// But the cure costs where the disease is not: the consumers then pick from a stream that passes them instead of a pile at the
// end of the belt, and a consumer with little spare capacity (Casimir Crystal, one machine of 0.85) catches 70 % of what passes
// and starves its chain (Plane Filter with Mk.III proliferator, Gravity Missile Set with Mk.III: both pass without it, and neither
// deadlocks). No structural rule tells the two apart: Gravity Missile Set has the same belt shape as Deuteron Fuel Rod, and a loop
// through a producer that makes another item as well is there in both. So these are candidates only: the plan lists them
// (`plan.surplus`), its slots, stations and power are those of a plan without sinks, and the layout solver builds the ladder without
// them, switching them on (`planWithSurplusSinks`) from the rung whose validation reports SIM_DEADLOCK on, in the measurement or in
// the probe that runs a passing sinkless layout of such a plan on to `DEADLOCK_PROBE_TICKS` (a deadlock can come long after the
// start-up). What the rule picks is the
// belts that two or more stages make: a lone producer fills the belt of its own item and waits, and the loop through it needs
// another producer to start it.
import type { Layout } from '../geometry';
import type { Flow, ItemRate, ProductionPlan, Stage } from './types';

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

/**
 * The candidates of `plan` that `layout` gave an export slot at a station for their surplus: the layout the solver found after a
 * deadlock. Empty for a layout built without sinks.
 */
export function surplusExportsIn(layout: Pick<Layout, 'buildings'>, plan: Pick<ProductionPlan, 'surplus'>): ItemRate[] {
  const stocked = new Set(layout.buildings.flatMap((b) => b.station?.slots.map((slot) => slot.itemId) ?? []));
  return (plan.surplus ?? []).filter((s) => stocked.has(s.itemId));
}
