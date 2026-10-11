/** Display formatting shared by the UI components. Pure, so it is tested without a DOM. */
import type { Building, GameData, GameDataIndex, Tech } from '../lib/data';

const DASH = '-';

/** Decimals that give `digits` significant digits for a magnitude (at least 0). */
function decimalsFor(magnitude: number, digits: number): number {
  if (magnitude === 0) return 0;
  return Math.max(0, digits - 1 - Math.floor(Math.log10(magnitude)));
}

/** `x` with `digits` significant digits, but never rounding away integer digits (1234.5 -> "1235"). */
function significant(x: number, digits: number): string {
  // toPrecision rounds first, so 999.6 is seen as 1000 and not given a decimal place it cannot show.
  const rounded = Number(Math.abs(x).toPrecision(digits));
  return x.toFixed(decimalsFor(rounded, digits));
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

const POWER_UNITS = ['W', 'kW', 'MW', 'GW'] as const;

/** Watts as "675 kW", "60.0 MW", "1.20 GW": three significant digits, unit chosen by magnitude. */
export function formatPower(w: number): string {
  if (!Number.isFinite(w)) return DASH;
  if (w === 0) return '0 W';
  const sign = w < 0 ? '-' : '';
  let value = Math.abs(w);
  let unit = 0;
  while (unit < POWER_UNITS.length - 1 && Number(value.toPrecision(3)) >= 1000) {
    value /= 1000;
    unit++;
  }
  return `${sign}${significant(value, 3)} ${POWER_UNITS[unit]}`;
}

/** A quantity with up to `digits` significant digits and no trailing zeros ("2", "2.46", "12.3"). */
export function formatCount(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return DASH;
  return trimZeros(significant(x, digits));
}

/** An items-per-second rate shown per second or per minute ("1.5/s", "90/min"). */
export function formatRate(perSecond: number, unit: 's' | 'min'): string {
  return `${formatCount(unit === 'min' ? perSecond * 60 : perSecond)}/${unit}`;
}

/** A 0..1 fraction as a whole percent. */
export function formatPercent(fraction: number): string {
  return Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : DASH;
}

/** English item name; an id GameData does not know is shown as "item <id>" rather than throwing. */
export function itemName(index: GameDataIndex, id: number): string {
  try {
    return index.item(id).name;
  } catch {
    return `item ${id}`;
  }
}

/** Building name, with the same fallback as `itemName`. */
export function buildingName(index: GameDataIndex, itemId: number): string {
  return index.building(itemId)?.name ?? `building ${itemId}`;
}

/** "Assembling Machine Mk.II (x1)": a building with its crafting speed, for facility selects. */
export function facilityLabel(building: Building): string {
  const raw = building.production?.speed ?? building.lab?.assembleSpeed;
  return raw === undefined ? building.name : `${building.name} (x${formatCount(raw / 10000)})`;
}

/** Leveled techs share a name across levels, so the level is part of the label. */
export function techLabel(tech: Pick<Tech, 'name' | 'level'>): string {
  return tech.level > 0 ? `${tech.name} ${tech.level}` : tech.name;
}

/**
 * The warning shown wherever the UI talks about geometry: footprints, spacing and blueprints are
 * only as good as the building colliders, which are approximate in the fixture and in any
 * extraction that could not read them (Review Focus #5). Null when every collider is extracted.
 */
export function geometryBadge(data: GameData): string | null {
  if (data.meta.source === 'fixture') return 'Geometry: approximate (fixture data)';
  if (data.buildings.some((b) => b.geometry.source === 'approximate')) return 'Geometry: approximate';
  return null;
}
