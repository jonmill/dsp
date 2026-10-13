import { describe, expect, it } from 'vitest';
import { GameDataIndex } from '../lib/data';
import { minimalGameData } from '../../test/fixtures/minimalGameData';
import {
  buildingName,
  facilityLabel,
  formatCount,
  formatDuration,
  formatPercent,
  formatTolerance,
  formatPower,
  formatRate,
  geometryBadge,
  itemName,
  noLayoutMessage,
  ROUTER_LIMIT_MACHINES,
  ROUTER_LIMIT_MACHINES_PROLIFERATED,
  surplusExportNote,
  techLabel,
} from './format';

describe('formatPower', () => {
  it('shows zero and sub-kilowatt values in watts', () => {
    expect(formatPower(0)).toBe('0 W');
    expect(formatPower(750)).toBe('750 W');
    expect(formatPower(5)).toBe('5.00 W');
  });

  it('uses three significant digits per unit', () => {
    expect(formatPower(675_000)).toBe('675 kW');
    expect(formatPower(999_000)).toBe('999 kW');
    expect(formatPower(12_345)).toBe('12.3 kW');
    expect(formatPower(1000)).toBe('1.00 kW');
    expect(formatPower(1.5e6)).toBe('1.50 MW');
    expect(formatPower(60e6)).toBe('60.0 MW');
    expect(formatPower(1.2e9)).toBe('1.20 GW');
  });

  it('moves to the next unit when rounding reaches 1000', () => {
    expect(formatPower(999_600)).toBe('1.00 MW');
    expect(formatPower(999_900_000)).toBe('1.00 GW');
    expect(formatPower(999.7)).toBe('1.00 kW');
  });

  it('keeps GW as the largest unit', () => {
    expect(formatPower(1.5e12)).toBe('1500 GW');
  });

  it('keeps the sign and rejects non-finite values', () => {
    expect(formatPower(-1.5e6)).toBe('-1.50 MW');
    expect(formatPower(Number.NaN)).toBe('-');
    expect(formatPower(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('formatRate', () => {
  it('trims trailing zeros and appends the unit', () => {
    expect(formatRate(1, 's')).toBe('1/s');
    expect(formatRate(0.5, 's')).toBe('0.5/s');
    expect(formatRate(1.2345, 's')).toBe('1.23/s');
    expect(formatRate(1 / 3, 's')).toBe('0.333/s');
    expect(formatRate(0, 's')).toBe('0/s');
  });

  it('converts per-second rates to per-minute', () => {
    expect(formatRate(1, 'min')).toBe('60/min');
    expect(formatRate(0.025, 'min')).toBe('1.5/min');
  });

  it('keeps whole numbers above 1000 whole', () => {
    expect(formatRate(1234.5, 's')).toBe('1235/s');
    expect(formatRate(0.001234, 's')).toBe('0.00123/s');
  });
});

describe('formatCount and formatPercent', () => {
  it('formats machine counts with three significant digits', () => {
    expect(formatCount(2)).toBe('2');
    expect(formatCount(2.456)).toBe('2.46');
    expect(formatCount(12.34)).toBe('12.3');
    expect(formatCount(0.5)).toBe('0.5');
    expect(formatCount(999.7)).toBe('1000');
  });

  it('formats utilization as a whole percent', () => {
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.4567)).toBe('46%');
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('itemName', () => {
  const index = new GameDataIndex(minimalGameData());

  it('returns the English item name', () => {
    expect(itemName(index, 1101)).toBe('Iron Ingot');
  });

  it('falls back to the id for an unknown item rather than throwing', () => {
    expect(itemName(index, 987654)).toBe('item 987654');
  });
});

describe('formatTolerance', () => {
  it('shows one decimal, so that 1.4 % is not read as 1 %', () => {
    expect(formatTolerance(0.01)).toBe('1.0 %');
    expect(formatTolerance(0.014)).toBe('1.4 %');
    expect(formatTolerance(0.0142857)).toBe('1.4 %');
    expect(formatTolerance(0.02)).toBe('2.0 %');
    expect(formatTolerance(Number.NaN)).toBe('-');
  });
});

describe('geometryBadge', () => {
  it('flags fixture data as approximate geometry', () => {
    const data = minimalGameData();
    expect(data.meta.source).toBe('fixture');
    expect(geometryBadge(data)).toBe('Geometry: approximate (fixture data)');
  });

  it('flags game data when any building geometry is approximate', () => {
    const data = minimalGameData();
    data.meta.source = 'game';
    data.buildings[0].geometry.source = 'approximate';
    expect(geometryBadge(data)).toBe('Geometry: approximate');
  });

  it('shows no badge for game data with extracted geometry throughout', () => {
    const data = minimalGameData();
    data.meta.source = 'game';
    for (const b of data.buildings) b.geometry.source = 'extracted';
    expect(geometryBadge(data)).toBeNull();
  });
});

describe('buildingName and facilityLabel', () => {
  const data = minimalGameData();
  const index = new GameDataIndex(data);
  const smelter = data.buildings[0];

  it('names a building, falling back to its id', () => {
    expect(buildingName(index, smelter.itemId)).toBe(smelter.name);
    expect(buildingName(index, 424242)).toBe('building 424242');
  });

  it('labels a facility with its speed', () => {
    smelter.production = { recipeType: 'SMELT', speed: 15000 };
    expect(facilityLabel(smelter)).toBe(`${smelter.name} (x1.5)`);
    smelter.production = undefined;
    smelter.lab = { assembleSpeed: 30000, researchSpeed: 10000 };
    expect(facilityLabel(smelter)).toBe(`${smelter.name} (x3)`);
    smelter.lab = undefined;
    expect(facilityLabel(smelter)).toBe(smelter.name);
  });
});

describe('techLabel', () => {
  it('adds the level of leveled techs', () => {
    expect(techLabel({ name: 'Mecha Core', level: 6 })).toBe('Mecha Core 6');
    expect(techLabel({ name: 'Processor', level: 0 })).toBe('Processor');
  });
});

describe('formatDuration', () => {
  it('shows minutes and zero-padded seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7_400)).toBe('0:07');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(600_000)).toBe('10:00');
    expect(formatDuration(75 * 60_000 + 30_999)).toBe('75:30');
  });

  it('shows a dash for what is not a duration', () => {
    expect(formatDuration(Number.NaN)).toBe('-');
    expect(formatDuration(-1)).toBe('-');
  });
});

describe('noLayoutMessage', () => {
  it('a budget stop of a plan over the router\'s limit names the machines and the limits, and says what to try, a longer budget included', () => {
    expect(noLayoutMessage('budget', 975, false)).toBe(
      "No valid layout found within the time budget, with some layout attempts left. This plan has 975 machines; plans over ~400 machines (or ~200 with proliferator) often can't be laid out yet. A longer time budget (in Options) may help. Try a lower rate, or split the build.",
    );
  });

  it('the limit is 200 machines with a proliferator and 400 without', () => {
    expect(ROUTER_LIMIT_MACHINES).toBe(400);
    expect(ROUTER_LIMIT_MACHINES_PROLIFERATED).toBe(200);
    const often = "often can't be laid out yet";
    expect(noLayoutMessage('budget', 300, true)).toContain(often);
    expect(noLayoutMessage('budget', 300, false)).not.toContain(often);
    expect(noLayoutMessage('budget', 200, true)).not.toContain(often);
    expect(noLayoutMessage('budget', 401, false)).toContain(often);
    expect(noLayoutMessage('budget', 401, false)).not.toContain('routed');
  });

  it('a smaller plan is not blamed on the router: its message suggests a longer budget on a budget stop only', () => {
    expect(noLayoutMessage('budget', 38, false)).toBe(
      'No valid layout found within the time budget, with some layout attempts left. This plan has 38 machines. A longer time budget (in Options) may help. Try a lower rate, or split the build.',
    );
    expect(noLayoutMessage('exhausted', 1, false)).toBe(
      'No valid layout was found: every layout attempt failed. This plan has 1 machine. Try a lower rate, or split the build.',
    );
  });

  it('only a stop at the budget suggests a longer budget: not when every rung was tried, not when the user stopped it, not for a big plan either', () => {
    for (const machines of [38, 975]) {
      expect(noLayoutMessage('budget', machines, false)).toContain('longer time budget');
      expect(noLayoutMessage('exhausted', machines, false)).not.toContain('longer time budget');
      expect(noLayoutMessage('early', machines, false)).not.toContain('longer time budget');
      expect(noLayoutMessage('user', machines, false)).not.toContain('longer time budget');
    }
  });

  it('says who stopped it', () => {
    expect(noLayoutMessage('user', 500, false)).toMatch(/^Stopped before a valid layout was found\. This plan has 500 machines;/);
    expect(noLayoutMessage('exhausted', 500, false)).toMatch(/^No valid layout was found: every layout attempt failed\. /);
    expect(noLayoutMessage('budget', 500, false)).toMatch(/^No valid layout found within the time budget, with some layout attempts left\. /);
  });
});

describe('surplusExportNote', () => {
  it('says which belts end at a station, that the game\'s slot stops at its maximum, and what to do about it', () => {
    const note = surplusExportNote(['Hydrogen']);
    expect(note).toContain('ends the belt of Hydrogen at a station, in an export slot for the surplus');
    expect(note).toContain("the game's slot stops at its maximum");
    expect(note).toContain('take Hydrogen out of that slot');
    expect(surplusExportNote(['Hydrogen', 'Graphene'])).toContain('Hydrogen, Graphene');
  });
});
