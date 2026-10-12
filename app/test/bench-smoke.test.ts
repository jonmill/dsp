// Smoke test of the benchmark harness (Task 27, scripts/bench.ts): the command line, the table row, the doc it appends
// to, and one real run of the solver on the smallest plan with a budget of a fraction of a second. The numbers a run
// records are the business of `npm run bench`; this checks that it records them in the right shape.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendRows, BENCH_PLANS, benchPlan, DEFAULT_PLANS, formatRow, parseArgs, runBench } from '../scripts/bench';
import type { BenchResult } from '../scripts/bench';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsp-bench-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const result = (over: Partial<BenchResult> = {}): BenchResult => ({
  plan: 'smelter-row',
  machines: 12,
  nets: 2,
  budgetS: 60,
  firstValidS: 0.25,
  firstFrom: 'ladder: margin 3',
  firstRatio: 1,
  firstFootprint: 1477,
  bestFootprint: 465,
  validated: 95,
  attempts: 200,
  stoppedBy: 'budget',
  wallS: 60.04,
  ...over,
});

describe('parseArgs', () => {
  it('defaults to a 60 s budget on the four plans of the benchmark, writing to docs/benchmarks.md', () => {
    const args = parseArgs([]);
    expect(args.budget).toBe(60);
    expect(args.plans).toEqual(['processor', 'quantum-chip', 'circuit-board', 'smelter-row']);
    expect(args.plans).toEqual(DEFAULT_PLANS);
    expect(args.seed).toBe(1);
    expect(args.write).toBe(true);
    expect(args.out.endsWith(join('docs', 'benchmarks.md'))).toBe(true);
  });

  it('reads the options of `npm run bench -- --budget 60 --plans processor,quantum-chip,circuit-board,smelter-row`', () => {
    const args = parseArgs(['--budget', '60', '--plans', 'processor,quantum-chip,circuit-board,smelter-row']);
    expect(args.budget).toBe(60);
    expect(args.plans).toEqual(['processor', 'quantum-chip', 'circuit-board', 'smelter-row']);
  });

  it('reads the seed, the label, the commit, the output file and --no-write', () => {
    const args = parseArgs(['--budget', '2.5', '--seed', '7', '--label', 'before Task 27', '--commit', 'abc1234', '--out', join(dir, 'x.md'), '--no-write']);
    expect(args).toMatchObject({ budget: 2.5, seed: 7, label: 'before Task 27', commit: 'abc1234', out: join(dir, 'x.md'), write: false });
  });

  it('refuses what it cannot run, naming it', () => {
    expect(() => parseArgs(['--plans', 'processor,nope'])).toThrow(/unknown plan "nope".*processor/);
    expect(() => parseArgs(['--budget', '0'])).toThrow(/budget/);
    expect(() => parseArgs(['--budget'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--seed', '1.5'])).toThrow(/seed/);
    expect(() => parseArgs(['--fast'])).toThrow(/unknown option --fast/);
    expect(() => parseArgs(['--plans', ''])).toThrow(/names no plan/);
  });

  it('knows the plans it is documented to run, and the ladder regression plan', () => {
    for (const name of ['processor', 'quantum-chip', 'circuit-board', 'smelter-row', 'pls']) expect(BENCH_PLANS[name]?.about, name).toBeTruthy();
  });
});

describe('formatRow', () => {
  const meta = { date: '2026-10-11', commit: '723fb7c', label: 'before' };

  it('is one markdown table row with the plan, the first valid layout, the best footprint and the validated count', () => {
    expect(formatRow(result(), meta)).toBe(
      '| 2026-10-11 | 723fb7c | before | smelter-row | 12 / 2 | 60 | 0.3 | ladder: margin 3 | 1.000 | 1477 | 465 | 95 / 200 | budget | 60.0 |',
    );
  });

  it('writes a dash where a run found no layout, and for an empty label', () => {
    const row = formatRow(result({ firstValidS: null, firstFrom: null, firstRatio: null, firstFootprint: null, bestFootprint: null, validated: 0, attempts: 6, stoppedBy: 'exhausted' }), {
      ...meta,
      label: '',
    });
    expect(row).toBe('| 2026-10-11 | 723fb7c | - | smelter-row | 12 / 2 | 60 | - | - | - | - | - | 0 / 6 | exhausted | 60.0 |');
  });

  it('has as many cells as the table header has columns', () => {
    const file = join(dir, 'cells.md');
    appendRows(file, [formatRow(result(), meta)]);
    const rows = readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(3);
    const cells = (line: string): number => line.split('|').length - 2;
    expect(cells(rows[1])).toBe(cells(rows[0]));
    expect(cells(rows[2])).toBe(cells(rows[0]));
  });
});

describe('appendRows', () => {
  it('starts a doc with its intro and table header when the file is new, and appends under the header after that', () => {
    const file = join(dir, 'doc.md');
    appendRows(file, ['| a |']);
    appendRows(file, ['| b |', '| c |']);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('# Solver benchmarks')).toBe(true);
    expect(text).toContain('npm run bench');
    const lines = text.trimEnd().split('\n');
    expect(lines.slice(-3)).toEqual(['| a |', '| b |', '| c |']);
    expect(lines.filter((l) => l.startsWith('| Date |'))).toHaveLength(1);
  });

  it('keeps what an existing doc has', () => {
    const file = join(dir, 'existing.md');
    writeFileSync(file, '# My notes\n\n| Date |\n| --- |\n| old |\n');
    appendRows(file, ['| new |']);
    expect(readFileSync(file, 'utf8')).toBe('# My notes\n\n| Date |\n| --- |\n| old |\n| new |\n');
  });
});

describe('a run of the solver', () => {
  it('records the time to the first valid layout, the best footprint and the validated count, and appends the row', async () => {
    const out = join(dir, 'run.md');
    const lines: string[] = [];
    const results = await runBench(parseArgs(['--budget', '0.5', '--plans', 'smelter-row', '--label', 'smoke', '--commit', 'test123', '--out', out]), (l) => lines.push(l));
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.plan).toBe('smelter-row');
    expect(r.machines).toBe(12);
    expect(r.firstValidS).not.toBeNull();
    expect(r.firstValidS as number).toBeGreaterThan(0);
    expect(r.firstFrom).toMatch(/^ladder: margin \d/);
    expect(r.firstRatio as number).toBeGreaterThanOrEqual(0.99);
    expect(r.bestFootprint as number).toBeGreaterThan(0);
    expect(r.bestFootprint as number).toBeLessThanOrEqual(r.firstFootprint as number);
    expect(r.validated).toBeGreaterThanOrEqual(1);
    expect(r.attempts).toBeGreaterThanOrEqual(r.validated);
    expect(r.stoppedBy).toBe('budget');
    expect(r.wallS).toBeGreaterThanOrEqual(0.5);

    const rows = readFileSync(out, 'utf8').split('\n').filter((l) => l.startsWith('| ') && l.includes('smoke'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('| test123 | smoke | smelter-row | 12 / 2 | 0.5 |');
    expect(lines.some((l) => l.includes('appended 1 row'))).toBe(true);
  }, 60_000);

  it('does not touch the doc with --no-write', async () => {
    const out = join(dir, 'untouched.md');
    await runBench(parseArgs(['--budget', '0.2', '--plans', 'circuit-board', '--out', out, '--no-write']), () => {});
    expect(() => readFileSync(out, 'utf8')).toThrow(/ENOENT/);
  }, 60_000);

  it('benchPlan names a plan it does not know', async () => {
    await expect(benchPlan('nope', 1, 1)).rejects.toThrow(/unknown plan "nope"/);
  });
});
