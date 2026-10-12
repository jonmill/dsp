// In-game regression runner (spec §11, "Simulator accuracy"). Every `test/fixtures/regression/*.json` is a blueprint the
// user built in the game together with the item rates measured there (format and how to record one: the README in that
// folder). For each fixture the blueprint is decoded, imported (`blueprintToLayout`), simulated (`runSimulation`) and
// every measured rate has to be matched by the simulator within 2 % (relative).
//
// The plan the simulator runs with is `regressionPlanFor`: it provisions no rate (0), so the adaptive warm-up never sees a
// rate reached and runs to its cap (20 game minutes), then the default window (5 game minutes) is measured. That is the
// steady state, which is what the user measures in game. The simulator is fast enough for that: a fixture takes seconds.
//
// With no fixtures the suite passes and says so. The runner's own logic is covered by the second block, on a fixture made
// in memory from the M0 layout (the simulator against itself, so it proves the plumbing and the 2 % rule, not accuracy).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildM0Layout } from '../scripts/emit-test-blueprint';
import { blueprintToLayout, decodeBlueprint, layoutToBlueprintString, regressionPlanFor } from '../src/lib/blueprint';
import { allTechs, compareGameVersions, computeTechEffects, GameDataIndex, loadDefaultGameData } from '../src/lib/data';
import { runSimulation } from '../src/lib/validate';
import type { SimOptions } from '../src/lib/validate';
import { loadFixtureGameData } from './fixtures/fixtureGameData';

/** A measured rate and the simulated one must agree to within this share of the measured one (spec §11). */
const TOLERANCE = 0.02;
/** A real fixture simulates 25 game minutes; allow for a large block. */
const FIXTURE_TIMEOUT_MS = 300_000;

const dir = fileURLToPath(new URL('./fixtures/regression/', import.meta.url));
const log = (line: string): void => void process.stdout.write(`${line}\n`);

/** A fixture file (`test/fixtures/regression/*.json`); see the README there. */
interface RegressionFixture {
  /** A `BLUEPRINT:` string. */
  blueprint: string;
  /** The game version the rates were measured on. Informational: a mismatch with the loaded GameData is logged. */
  gameVersion: string;
  /** The item the block delivers: counted where it arrives at a station input port. */
  targetItemId: number;
  /** Items per second measured in game, by item id. */
  measuredRates: Record<string, number>;
  notes: string;
  /** Researched techs (ids) when measuring. Default: all of them. Sorter stacking and station piling depend on it. */
  unlockedTechs?: number[];
}

/** `json` as a fixture, or an error naming `file` and the first thing wrong. */
function parseFixture(json: unknown, file: string): RegressionFixture {
  const fail = (why: string): never => {
    throw new Error(`${file}: ${why}`);
  };
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return fail('expected a JSON object');
  const f = json as Record<string, unknown>;
  if (typeof f.blueprint !== 'string' || !f.blueprint.startsWith('BLUEPRINT:')) fail('"blueprint" must be a string starting with BLUEPRINT:');
  if (typeof f.gameVersion !== 'string') fail('"gameVersion" must be a string');
  if (!Number.isInteger(f.targetItemId)) fail('"targetItemId" must be an item id (integer)');
  const rates = f.measuredRates;
  if (typeof rates !== 'object' || rates === null || Array.isArray(rates) || Object.keys(rates).length === 0) {
    fail('"measuredRates" must be an object of item id to items per second, with at least one entry');
  }
  for (const [id, rate] of Object.entries(rates as Record<string, unknown>)) {
    if (!/^\d+$/.test(id)) fail(`"measuredRates" key "${id}" is not an item id`);
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) fail(`"measuredRates" item ${id}: ${String(rate)} is not a rate`);
  }
  if (f.unlockedTechs !== undefined && !(Array.isArray(f.unlockedTechs) && f.unlockedTechs.every((t) => Number.isInteger(t)))) {
    fail('"unlockedTechs" must be an array of tech ids');
  }
  return {
    blueprint: f.blueprint as string,
    gameVersion: f.gameVersion as string,
    targetItemId: f.targetItemId as number,
    measuredRates: rates as Record<string, number>,
    notes: typeof f.notes === 'string' ? f.notes : '',
    unlockedTechs: f.unlockedTechs as number[] | undefined,
  };
}

interface RateRow {
  itemId: number;
  measured: number;
  simulated: number;
  /** Some station in the blueprint has a slot for the item; otherwise the simulator can never count it. */
  countable: boolean;
}

/** Imports and simulates `fixture`; one row per measured item. */
function simulateFixture(fixture: RegressionFixture, data: GameDataIndex, opts: SimOptions = {}): { rows: RateRow[]; warnings: string[] } {
  const effects = computeTechEffects(data.data, fixture.unlockedTechs ? new Set(fixture.unlockedTechs) : allTechs(data.data));
  const imported = blueprintToLayout(decodeBlueprint(fixture.blueprint), data);
  const items = Object.keys(fixture.measuredRates).map(Number);
  const plan = regressionPlanFor(imported.layout, data, effects, { targetItemId: fixture.targetItemId, alsoReport: items });
  const sim = runSimulation(imported.layout, plan, data, effects, opts);
  const slotItems = new Set(imported.layout.buildings.flatMap((b) => b.station?.slots.map((s) => s.itemId) ?? []));
  const rows = items.map((itemId): RateRow => {
    const simulated = sim.measuredExports.find((e) => e.itemId === itemId)?.perSecond ?? 0;
    return { itemId, measured: fixture.measuredRates[String(itemId)], simulated, countable: slotItems.has(itemId) };
  });
  return { rows, warnings: [...imported.warnings, ...sim.warnings] };
}

const itemName = (data: GameDataIndex, itemId: number): string => {
  try {
    return data.item(itemId).name;
  } catch {
    return `item ${itemId}`;
  }
};

/** One line per row whose simulated rate is more than `TOLERANCE` (relative to the measured one) off; empty when all agree. */
function mismatches(rows: RateRow[], data: GameDataIndex): string[] {
  return rows.flatMap((r) => {
    if (Math.abs(r.simulated - r.measured) <= TOLERANCE * Math.abs(r.measured)) return [];
    const off = r.measured === 0 ? 'measured 0' : `${(((r.simulated - r.measured) / r.measured) * 100).toFixed(1)} %`;
    const hint = r.countable ? '' : '; no station in the blueprint has a slot for this item, so the simulator cannot count it';
    return [
      `${itemName(data, r.itemId)} (${r.itemId}): simulated ${r.simulated.toFixed(3)}/s, measured ${r.measured.toFixed(3)}/s (${off}, allowed ±${TOLERANCE * 100} %)${hint}`,
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// The user's fixtures

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('in-game regression fixtures', () => {
  if (files.length === 0) {
    it('has no regression fixtures yet', () => {
      log('no regression fixtures yet: add app/test/fixtures/regression/<name>.json (see the README there)');
      expect(files).toEqual([]);
    });
    return;
  }

  let loaded: Promise<GameDataIndex> | undefined;
  const gameData = (): Promise<GameDataIndex> => (loaded ??= loadDefaultGameData().then((d) => new GameDataIndex(d)));

  it.each(files)(
    '%s: every measured rate is matched within 2 percent',
    async (file) => {
      const fixture = parseFixture(JSON.parse(readFileSync(join(dir, file), 'utf8')), file);
      const data = await gameData();
      if (compareGameVersions(fixture.gameVersion, data.data.meta.gameVersion) !== 0) {
        log(`${file}: measured on game version ${fixture.gameVersion}, simulated with GameData ${data.data.meta.gameVersion} (${data.data.meta.source})`);
      }
      const { rows, warnings } = simulateFixture(fixture, data);
      for (const w of warnings) log(`${file}: ${w}`);
      for (const r of rows) log(`${file}: ${itemName(data, r.itemId)} simulated ${r.simulated.toFixed(3)}/s, measured ${r.measured.toFixed(3)}/s`);
      expect(mismatches(rows, data), fixture.notes).toEqual([]);
    },
    FIXTURE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------------------------
// The runner itself

describe('regression runner', () => {
  const data = new GameDataIndex(loadFixtureGameData());
  /** Short windows: the M0 row settles within a game minute. */
  const SHORT: SimOptions = { warmupTicks: 3600, measureTicks: 7200 };
  const m0Blueprint = layoutToBlueprintString(buildM0Layout(data), data, { shortDesc: 'M0', desc: '' });
  const fixtureWith = (measuredRates: Record<string, number>, over: Partial<RegressionFixture> = {}): RegressionFixture => ({
    blueprint: m0Blueprint,
    gameVersion: data.data.meta.gameVersion,
    targetItemId: 1101,
    measuredRates,
    notes: 'synthetic',
    ...over,
  });
  /** What the simulator says for the M0 row: three Arc Smelters, 3 Iron Ingots/s. */
  let cached: number | undefined;
  const simulatedRate = (): number => (cached ??= simulateFixture(fixtureWith({ 1101: 3 }), data, SHORT).rows[0].simulated);

  it('reads the simulated M0 row at 3 Iron Ingots/s', () => {
    expect(simulatedRate()).toBeGreaterThan(2.9);
    expect(simulatedRate()).toBeLessThan(3.1);
  });

  it('a measurement the simulator reproduces matches', () => {
    const { rows, warnings } = simulateFixture(fixtureWith({ 1101: simulatedRate() }), data, SHORT);
    expect(mismatches(rows, data)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it.each([
    { name: '1.5 % below', factor: 1 / 0.985, fails: false },
    { name: '1.5 % above', factor: 1 / 1.015, fails: false },
    { name: '3 % below', factor: 1 / 0.97, fails: true },
    { name: '3 % above', factor: 1 / 1.03, fails: true },
  ])('a measurement the simulator misses by $name: fails = $fails', ({ factor, fails }) => {
    const simulated = simulatedRate();
    const measured = simulated * factor;
    const { rows } = simulateFixture(fixtureWith({ 1101: measured }), data, SHORT);
    const found = mismatches(rows, data);
    if (!fails) expect(found).toEqual([]);
    else {
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/Iron Ingot \(1101\): simulated \d\.\d+\/s, measured \d\.\d+\/s \(-?\d+\.\d %, allowed ±2 %\)/);
    }
  });

  it('checks every measured item, and says when no station can count one', () => {
    // Object keys that are integers come out in ascending order.
    const { rows } = simulateFixture(fixtureWith({ 1101: simulatedRate(), 1001: 2, 1102: 1 }), data, SHORT);
    expect(rows.map((r) => [r.itemId, r.countable])).toEqual([
      [1001, true],
      [1101, true],
      [1102, false],
    ]);
    // The ore is counted only where it arrives, and it only leaves the station.
    const found = mismatches(rows, data);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/Iron Ore \(1001\): simulated 0\.000\/s, measured 2\.000\/s/);
    expect(found[0]).not.toMatch(/cannot count/);
    expect(found[1]).toMatch(/\(1102\).*measured 1\.000\/s.*cannot count it/);
  });

  it('a measured 0 matches only a simulated 0', () => {
    const { rows } = simulateFixture(fixtureWith({ 1101: simulatedRate(), 1001: 0 }), data, SHORT);
    expect(mismatches(rows, data)).toEqual([]);
    expect(mismatches([{ itemId: 1001, measured: 0, simulated: 0.01, countable: true }], data)).toHaveLength(1);
  });

  it('the fixture picks the techs: without any, the simulator still runs', () => {
    const { rows } = simulateFixture(fixtureWith({ 1101: simulatedRate() }, { unlockedTechs: [] }), data, SHORT);
    expect(rows[0].simulated).toBeGreaterThan(2.9);
  });

  describe('parseFixture', () => {
    const good = { blueprint: 'BLUEPRINT:0,...', gameVersion: '0.10.33.27026', targetItemId: 1101, measuredRates: { '1101': 2.9 }, notes: 'x' };
    it('accepts the documented format, with or without notes and techs', () => {
      expect(parseFixture(good, 'a.json').measuredRates).toEqual({ '1101': 2.9 });
      expect(parseFixture({ ...good, notes: undefined }, 'a.json').notes).toBe('');
      expect(parseFixture({ ...good, unlockedTechs: [1, 2] }, 'a.json').unlockedTechs).toEqual([1, 2]);
    });
    it.each([
      [{ ...good, blueprint: 'nope' }, /a\.json: "blueprint"/],
      [{ ...good, gameVersion: 1 }, /"gameVersion"/],
      [{ ...good, targetItemId: '1101' }, /"targetItemId"/],
      [{ ...good, measuredRates: {} }, /"measuredRates" must be/],
      [{ ...good, measuredRates: { iron: 3 } }, /key "iron"/],
      [{ ...good, measuredRates: { '1101': -1 } }, /item 1101: -1/],
      [{ ...good, unlockedTechs: ['x'] }, /"unlockedTechs"/],
      [[], /expected a JSON object/],
    ])('rejects %j', (bad, message) => {
      expect(() => parseFixture(bad, 'a.json')).toThrow(message);
    });
  });
});
