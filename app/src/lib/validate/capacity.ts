// Rate-capacity check: does every belt, every sorter and every machine input carry what the plan asks of it?
// This is the fast gate the layout solver calls in its inner loop (Task 16), so it works from the Layout and the
// plan alone with precomputed id maps: O(buildings + belts + sorters), no geometry.
//
// Matching machines to plan stages. The required input of a machine is its stage's input total divided by the
// stage's machine count: the planned, utilization-weighted rate, not the rate at full speed. A production building
// belongs to a stage through `PlacedBuilding.role`: `stage:<stageIndex>` (an index into `plan.stages`) picks that
// stage; any other role, an index outside the plan, or no role at all falls back to the first stage whose
// `recipeId` equals the building's `recipeId`. A building that matches no stage is not judged. The layout solver
// sets `role` to `stage:<stageIndex>` when it places a stage's machines.
//
// Stacks. Only the bottom lab of a stack (`stackParentId`) takes sorters (MX §4.4), so the stack is one machine: its
// bottom lab must be fed what every lab of the stack uses, the sum of their stages' per-machine inputs.
//
// Which sorters feed which ingredient. A sorter dropping into a building carries its `filterItemId`; an unfiltered
// one (filter 0) carries the item of the belt it picks from. An unfiltered sorter that picks from a building is
// attributed to no ingredient. Each ingredient needs the planned rates of its sorters to add up to at least 99.9 %
// of the required rate.
import type { ProductionPlan, Stage } from '../calc';
import type { GameDataIndex, TechEffects } from '../data';
import type { BeltPath, Layout, PlacedBuilding, Sorter } from '../geometry';
import type { Violation, ViolationEntity } from './types';

/** A cargo holds at most four items (MX §2.1). */
const MAX_CARGO_STACK = 4;
/** `stt` is in units of 1/10000 tick; a sorter leg takes at least one tick (MX §3.1). */
const STT_PER_TICK = 10000;
/** Sorter grade of the pile sorter (MX §3.1); the other grades keep a cargo's stack, they do not build one. */
const PILE_SORTER_GRADE = 4;
/** An ingredient is met when the sorters deliver at least this share of the planned rate. */
const SUPPLY_FACTOR = 0.999;
/** Relative slack for float noise, on top of `SUPPLY_FACTOR`. */
const REL_EPS = 1e-9;
const STAGE_ROLE = /^stage:(\d+)$/;

/**
 * Items per second a belt of this tier carries when each cargo holds `stack` items: `speed · ticksPerSecond /
 * cargoLength · stack` (MX §2.1). Throws if the item is not a belt.
 */
export function beltCapacity(tierItemId: number, stack: number, data: GameDataIndex): number {
  const belt = data.building(tierItemId)?.belt;
  if (!belt) throw new Error(`GameData has no belt for item ${tierItemId}`);
  const { ticksPerSecond, cargoLength } = data.data.constants;
  return ((belt.speed * ticksPerSecond) / cargoLength) * stack;
}

/**
 * Items per second a sorter moves. A round trip takes `2 · max(10000, stt · span) / 10000` ticks and carries
 * `itemsPerTrip` items (MX §3.1, §3.4):
 *  - a non-pile sorter picking from a belt carries that belt's stack (`stackFromBelt`) and one item from a building;
 *  - the pile sorter accumulates `min(effects.inserterStackInput, 4)` items from a belt, one from a building.
 *
 * `stt` grows with span for every grade, the pile sorter included. That is a ruling: BF/CYING claim the pile
 * sorter's speed does not depend on length, but that is unverified (MX §3.1, C3) and the wiki's player-measured pile
 * table falls with distance, so scaling is the conservative choice (`sorterSettings` in sim/sorter.ts agrees).
 *
 * `stackFromBelt` is the stack of the belt the sorter picks from; pass 0 when it picks from a building.
 * Throws if the item is not a sorter.
 */
export function sorterRate(
  tierItemId: number,
  span: number,
  stackFromBelt: number,
  effects: TechEffects,
  data: GameDataIndex,
): number {
  const sorter = data.building(tierItemId)?.sorter;
  if (!sorter) throw new Error(`GameData has no sorter for item ${tierItemId}`);
  const pile = sorter.grade === PILE_SORTER_GRADE;
  const fromBelt = stackFromBelt > 0;
  const stt = sorter.stt * span;
  const roundTripTicks = (2 * Math.max(STT_PER_TICK, stt)) / STT_PER_TICK;
  let itemsPerTrip = 1;
  if (fromBelt) itemsPerTrip = pile ? Math.min(effects.inserterStackInput, MAX_CARGO_STACK) : stackFromBelt;
  return (data.data.constants.ticksPerSecond / roundTripTicks) * itemsPerTrip;
}

/**
 * Items per cargo on a belt: the tech-level station stack for a belt that leaves a station port, 1 for any other
 * belt (a belt fed by a sorter or another belt inherits nothing).
 */
export function beltStack(belt: BeltPath, effects: TechEffects): number {
  return belt.source ? effects.stationPilerLevel : 1;
}

/** `rate` is more than `limit` by more than float noise. */
const exceeds = (rate: number, limit: number): boolean => rate > limit * (1 + REL_EPS);

/** `supplied` falls short of 99.9 % of `required` by more than float noise. */
const fallsShort = (supplied: number, required: number): boolean =>
  supplied < required * SUPPLY_FACTOR * (1 - REL_EPS);

/** A rate for a message: up to three decimals, no trailing zeros. */
const fmt = (rate: number): string => `${+rate.toFixed(3)}/s`;

function itemName(data: GameDataIndex, itemId: number): string {
  try {
    return data.item(itemId).name;
  } catch {
    return `item ${itemId}`;
  }
}

/** What the sorters dropping into one building deliver of one item. */
interface Feed {
  rate: number;
  sorters: number[];
}

/**
 * Check the planned rates of a layout against what its belts, sorters and machine inputs can carry (Task 16).
 * Returns RATE_BELT, then RATE_SORTER, then RATE_MACHINE_INPUT violations; an empty array means the layout passes.
 * Throws only where GameData lacks a belt or sorter for a placed tier. A sorter that picks from a belt missing
 * from the layout is judged at stack 1 (the geometry checks report the dangling reference).
 */
export function checkCapacity(
  layout: Layout,
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
): Violation[] {
  const beltById = new Map<number, BeltPath>();
  for (const belt of layout.belts) beltById.set(belt.id, belt);

  // RATE_BELT
  const beltViolations: Violation[] = [];
  for (const belt of layout.belts) {
    const stack = beltStack(belt, effects);
    const capacity = beltCapacity(belt.tierItemId, stack, data);
    if (!exceeds(belt.plannedRate, capacity)) continue;
    beltViolations.push({
      code: 'RATE_BELT',
      entities: [{ kind: 'belt', id: belt.id }],
      message:
        `belt ${belt.id} (${data.building(belt.tierItemId)?.name}) is planned at ${fmt(belt.plannedRate)} but carries ` +
        `at most ${fmt(capacity)} at stack ${stack}`,
    });
  }

  // RATE_SORTER, and the deliveries into buildings that RATE_MACHINE_INPUT needs: building id -> item id -> feed.
  const sorterViolations: Violation[] = [];
  const feeds = new Map<number, Map<number, Feed>>();
  for (const s of layout.sorters) {
    const pickBelt = s.pick.kind === 'belt' ? beltById.get(s.pick.beltId) : undefined;
    const stack = s.pick.kind === 'belt' ? (pickBelt ? beltStack(pickBelt, effects) : 1) : 0;
    const rate = sorterRate(s.tierItemId, s.span, stack, effects, data);
    if (exceeds(s.plannedRate, rate)) {
      sorterViolations.push({
        code: 'RATE_SORTER',
        entities: [{ kind: 'sorter', id: s.id }],
        message:
          `sorter ${s.id} (${data.building(s.tierItemId)?.name}, span ${s.span}) is planned at ${fmt(s.plannedRate)} ` +
          `but moves at most ${fmt(rate)} ${stack > 0 ? `from a belt at stack ${stack}` : 'from a building'}`,
      });
    }
    if (s.drop.kind === 'building') addFeed(feeds, s.drop.buildingId, s, pickBelt);
  }

  // RATE_MACHINE_INPUT
  const firstStageOfRecipe = new Map<number, Stage>();
  for (const stage of plan.stages) {
    if (!firstStageOfRecipe.has(stage.recipeId)) firstStageOfRecipe.set(stage.recipeId, stage);
  }
  const machineViolations: Violation[] = [];
  const stageOf = (b: PlacedBuilding): Stage | undefined => {
    const tag = b.role === undefined ? null : STAGE_ROLE.exec(b.role);
    return (
      (tag ? plan.stages[Number(tag[1])] : undefined) ??
      (b.recipeId === undefined ? undefined : firstStageOfRecipe.get(b.recipeId))
    );
  };
  // A stack of labs is one machine: only its bottom building takes sorters (MX §4.4), and it must bring in what every
  // lab of the stack uses. `stacks` lists the buildings stacked on a building of the layout under their bottom one.
  const placed = new Set(layout.buildings.map((b) => b.id));
  const byId = new Map(layout.buildings.map((b) => [b.id, b] as const));
  const bottomOf = (b: PlacedBuilding): PlacedBuilding => {
    let at = b;
    for (let steps = 0; steps < layout.buildings.length && at.stackParentId !== undefined; steps++) {
      const below = byId.get(at.stackParentId);
      if (!below || below === at) break;
      at = below;
    }
    return at;
  };
  const stacks = new Map<number, PlacedBuilding[]>();
  for (const b of layout.buildings) {
    if (b.stackParentId === undefined || !placed.has(b.stackParentId)) continue;
    const bottom = bottomOf(b);
    if (bottom === b) continue; // a loop of stackParentIds: the geometry checks report it
    const list = stacks.get(bottom.id);
    if (list) list.push(b);
    else stacks.set(bottom.id, [b]);
  }
  for (const b of layout.buildings) {
    if (b.stackParentId !== undefined && placed.has(b.stackParentId)) continue;
    const members = [b, ...(stacks.get(b.id) ?? [])];
    // item id -> what the stack's machines take per second, in the order the plan lists the inputs
    const required = new Map<number, number>();
    for (const member of members) {
      const stage = stageOf(member);
      if (!stage || stage.machines <= 0) continue;
      for (const input of stage.inputs) required.set(input.itemId, (required.get(input.itemId) ?? 0) + input.perSecond / stage.machines);
    }
    for (const [itemId, need] of required) {
      const feed = feeds.get(b.id)?.get(itemId);
      const supplied = feed?.rate ?? 0;
      if (!fallsShort(supplied, need)) continue;
      const entities: ViolationEntity[] = [{ kind: 'building', id: b.id }];
      for (const id of feed?.sorters ?? []) entities.push({ kind: 'sorter', id });
      const wants = members.length > 1 ? `its stack of ${members.length} needs ${fmt(need)} in all` : `its stage needs ${fmt(need)} per machine`;
      machineViolations.push({
        code: 'RATE_MACHINE_INPUT',
        entities,
        message:
          `building ${b.id} (${data.building(b.itemId)?.name}) gets ${fmt(supplied)} of ${itemName(data, itemId)} ` +
          `from ${feed?.sorters.length ?? 0} sorter(s), but ${wants}`,
      });
    }
  }

  return [...beltViolations, ...sorterViolations, ...machineViolations];
}

/** Records that sorter `s` delivers its planned rate into building `buildingId`, if it carries a known item. */
function addFeed(
  feeds: Map<number, Map<number, Feed>>,
  buildingId: number,
  s: Sorter,
  pickBelt: BeltPath | undefined,
): void {
  const itemId = s.filterItemId !== 0 ? s.filterItemId : pickBelt?.itemId;
  if (!itemId) return;
  let byItem = feeds.get(buildingId);
  if (!byItem) feeds.set(buildingId, (byItem = new Map()));
  let feed = byItem.get(itemId);
  if (!feed) byItem.set(itemId, (feed = { rate: 0, sorters: [] }));
  feed.rate += s.plannedRate;
  feed.sorters.push(s.id);
}
