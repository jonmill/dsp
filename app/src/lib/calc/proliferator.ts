/**
 * Proliferator effects (docs/research/mechanics.md §5). Tier n is item 1140+n. A machine either gets
 * extra products or a speed-up from the same spray, never both.
 */
import type { GameDataIndex, Recipe } from '../data';
import type { ProliferatorSetting } from './types';

type Tier = ProliferatorSetting['tier'];
type Mode = ProliferatorSetting['mode'];

export interface ProliferatorEffect {
  outputMultiplier: number;
  speedMultiplier: number;
  /** Multiplies the work power; idle power is unchanged. */
  powerMultiplier: number;
  proliferated: boolean;
}

/** Ability (inc points per item) by tier, used when the item carries no `proliferator` block. */
const ABILITY_BY_TIER: Record<1 | 2 | 3, number> = { 1: 1, 2: 2, 3: 4 };

const FIRST_PROLIFERATOR_ITEM = 1140;

/** The proliferator item for a tier: Mk.I 1141, Mk.II 1142, Mk.III 1143. */
export function proliferatorItemId(tier: 1 | 2 | 3): number {
  return FIRST_PROLIFERATOR_ITEM + tier;
}

function abilityOf(tier: 1 | 2 | 3, data: GameDataIndex): number {
  return data.item(proliferatorItemId(tier)).proliferator?.ability ?? ABILITY_BY_TIER[tier];
}

/** Sprays one proliferator item yields (`hpMax`: 12 / 24 / 60). Self-spraying loops are not modelled. */
export function spraysPerItem(tier: 1 | 2 | 3, data: GameDataIndex): number {
  const sprays = data.item(proliferatorItemId(tier)).proliferator?.sprays;
  if (sprays === undefined) throw new Error(`GameData item ${proliferatorItemId(tier)} has no proliferator sprays`);
  return sprays;
}

/**
 * Extra products need a productive recipe whose every input item is productive (buildings, rockets,
 * Critical Photon and fuel rods are not). Anything else can only take the speed-up.
 */
export function canUseExtra(recipe: Recipe, data: GameDataIndex): boolean {
  return !recipe.nonProductive && recipe.inputs.every((input) => data.item(input.itemId).productive);
}

/**
 * What the chosen proliferator does to a stage running `recipe`. `extra` that the recipe cannot take
 * falls back to the speed-up; the caller can tell from `canUseExtra`.
 */
export function effectFor(tier: Tier, mode: Mode, recipe: Recipe, data: GameDataIndex): ProliferatorEffect {
  if (tier === 0) return { outputMultiplier: 1, speedMultiplier: 1, powerMultiplier: 1, proliferated: false };
  const ability = abilityOf(tier, data);
  const { incTableMilli, accTableMilli, powerTableRatio } = data.data.constants;
  const powerMultiplier = 1 + powerTableRatio[ability] / 1000;
  if (mode === 'extra' && canUseExtra(recipe, data)) {
    return { outputMultiplier: 1 + incTableMilli[ability] / 1000, speedMultiplier: 1, powerMultiplier, proliferated: true };
  }
  return { outputMultiplier: 1, speedMultiplier: 1 + accTableMilli[ability] / 1000, powerMultiplier, proliferated: true };
}
