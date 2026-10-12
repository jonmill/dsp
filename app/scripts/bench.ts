// Solver benchmark harness (Task 27). Run with `npm run bench -- --budget 60 --plans processor,quantum-chip,circuit-board,smelter-row`.
//
// For each plan it runs the solver on the fixture data with a real clock and records
//  - the time to the first layout that passes the full validator (the fallback ladder's result, from the start of
//    `solve`: netlist, placement, taps, routing, power and the simulation included),
//  - the best footprint (tiles) after the budget, and how many candidates passed the static checks ("validated"),
// and appends one dated row per plan to docs/benchmarks.md. The early stop is off (`minRunMs` is the budget), so every
// plan uses its whole budget and the footprints compare between runs. The fallback ladder is not bound by the budget
// (a plan whose ladder takes longer than the budget just ends after it), so the time to first layout can exceed it.
//
// Options: --budget <seconds> (default 60), --plans <a,b,..> (default the four above), --seed <n> (default 1),
// --label <text> (a note for the row: "before", "after"...), --commit <text> (the commit column; default HEAD, marked
// +dirty when the app has uncommitted changes), --out <file> (default docs/benchmarks.md), --no-write (print the rows only). The plans: see `BENCH_PLANS`; `pls` is the ladder regression check (Planetary
// Logistics Station, which passes only at the widest margin) and is not in the default set.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compatibleFacilities, planProduction, plannableProducers } from '../src/lib/calc';
import type { PlanRequest, ProductionPlan } from '../src/lib/calc';
import { provisionedRate } from '../src/lib/validate/sim/run';
import { DEFAULT_SOLVE_OPTIONS, solve } from '../src/lib/layout/solver';
import type { SolveResult } from '../src/lib/layout/solver';
import { buildNetlist } from '../src/lib/layout/netlist';
import { data, effects, everything, planFor, processorPlan, quantumPlan, SMELTER } from '../src/lib/layout/testkit';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_OUT = resolve(repoRoot, 'docs/benchmarks.md');

export interface BenchPlan {
  /** What the plan is, for the doc. */
  about: string;
  make: () => Promise<ProductionPlan>;
}

const PLANETARY_LOGISTICS_STATION = 2103;
/** The items the ladder sweep (test/ladder-sweep.e2e.test.ts) supplies: the ores and the other raw resources. */
const SWEEP_RAW_ITEMS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1030, 1031];

/** The plan the ladder sweep makes for `itemId`: 1/s, all techs, the first unlocked facility of its first plannable recipe. */
async function sweepPlan(itemId: number): Promise<ProductionPlan> {
  const recipe = plannableProducers(itemId, data, effects)[0];
  const facility = recipe && compatibleFacilities(recipe, data).find((b) => effects.availableBuildings.has(b.itemId));
  if (!facility) throw new Error(`item ${itemId} has no plannable recipe on an unlocked facility`);
  const request: PlanRequest = {
    targetItemId: itemId,
    quantity: { kind: 'rate', perSecond: 1 },
    finalFacilityItemId: facility.itemId,
    unlockedTechs: everything,
    suppliedItemIds: new Set(SWEEP_RAW_ITEMS),
    facilityOverrides: {},
    recipeOverrides: {},
    proliferator: { tier: 0, mode: 'extra' },
    stationKind: 'planetary',
  };
  const planned = await planProduction(request, data, effects);
  if (!planned.ok) throw new Error(`plan failed: ${planned.error.kind}: ${planned.error.message}`);
  return planned.plan;
}

export const BENCH_PLANS: Record<string, BenchPlan> = {
  processor: {
    about: '1 Processor/s on Mk.III assemblers from iron, copper and silicon ore',
    make: () => processorPlan(1),
  },
  'quantum-chip': {
    about: '1 Quantum Chip/s on base-tier machines from the raw resources and Hydrogen (19 stages, 231 machines)',
    make: quantumPlan,
  },
  'circuit-board': {
    about: '1 Circuit Board/s on Mk.I assemblers from iron and copper ore',
    make: () => planFor({ targetItemId: 1301, suppliedItemIds: new Set([1001, 1002]) }),
  },
  'smelter-row': {
    about: '12 Iron Ingots/s on twelve Arc Smelters from iron ore',
    make: () =>
      planFor({
        targetItemId: 1101,
        finalFacilityItemId: SMELTER,
        quantity: { kind: 'rate', perSecond: 12 },
        suppliedItemIds: new Set([1001]),
      }),
  },
  pls: {
    about: '1 Planetary Logistics Station/s as the ladder sweep plans it: the fallback ladder regression check (passes only at margin 6)',
    make: () => sweepPlan(PLANETARY_LOGISTICS_STATION),
  },
};

export const DEFAULT_PLANS = ['processor', 'quantum-chip', 'circuit-board', 'smelter-row'];

export interface BenchResult {
  plan: string;
  machines: number;
  nets: number;
  budgetS: number;
  /** Seconds from the start of `solve` to the first layout that passed the full validator; null if none did. */
  firstValidS: number | null;
  /** Where the first layout came from (the progress phase when it was emitted), e.g. `ladder: margin 3`. */
  firstFrom: string | null;
  /** The first layout's simulated target rate over the rate asked for. */
  firstRatio: number | null;
  /** Footprint in tiles of the first layout and of the best one. */
  firstFootprint: number | null;
  bestFootprint: number | null;
  validated: number;
  attempts: number;
  stoppedBy: SolveResult['stoppedBy'];
  /** Wall-clock seconds of the whole `solve`. */
  wallS: number;
}

/** Runs the solver on one plan and records what the benchmark reports. */
export async function benchPlan(name: string, budgetS: number, seed: number, now: () => number = () => performance.now()): Promise<BenchResult> {
  const known = BENCH_PLANS[name];
  if (!known) throw new Error(`unknown plan "${name}"; the plans are: ${Object.keys(BENCH_PLANS).join(', ')}`);
  const plan = await known.make();
  const net = buildNetlist(plan, data, effects);
  const wanted = provisionedRate(plan);

  const t0 = now();
  let first: { at: number; ratio: number; footprint: number; from: string | null } | null = null;
  const result = solve(
    plan,
    data,
    effects,
    { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: budgetS * 1000, minRunMs: budgetS * 1000, seed, now },
    (p) => {
      if (first && first.from === null) first.from = p.phase;
    },
    (_layout, report, footprint) => {
      if (first === null) first = { at: now() - t0, ratio: wanted > 0 ? (report.sim?.measuredTargetRate ?? 0) / wanted : 0, footprint, from: null };
    },
    () => false,
  );
  const wallS = (now() - t0) / 1000;
  const found = first as { at: number; ratio: number; footprint: number; from: string | null } | null;
  return {
    plan: name,
    machines: net.machines.length,
    nets: net.nets.length,
    budgetS,
    firstValidS: found ? found.at / 1000 : null,
    firstFrom: found?.from ?? null,
    firstRatio: found?.ratio ?? null,
    firstFootprint: found?.footprint ?? null,
    bestFootprint: result.footprint,
    validated: result.validated,
    attempts: result.attempts,
    stoppedBy: result.stoppedBy,
    wallS,
  };
}

// ---------------------------------------------------------------------------------------------
// The doc

const TABLE_HEADER = [
  '| Date | Commit | Label | Plan | Machines / nets | Budget (s) | First valid (s) | First from | First rate | First footprint | Best footprint | Validated / attempts | Stopped by | Wall (s) |',
  '| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |',
];

const DOC_INTRO = `# Solver benchmarks

Produced by \`npm run bench -- --budget 60 --plans processor,quantum-chip,circuit-board,smelter-row\` (\`app/scripts/bench.ts\`).
Each row is one plan on one run of the solver with the fixture data, one thread, seed 1 unless the label says otherwise, the
early stop off (so the whole budget is used), motifs off. Times are wall-clock on the machine that ran it, so compare rows
of one machine only. A run does not repeat: the annealer makes as many moves as the time allows, so the footprint of a run
varies by 10-20 % with the seed and the load; compare means over several \`--seed\`s.

- **First valid**: seconds from the start of \`solve\` to the first layout that passed the full validator (placement, taps,
  routing, power, static checks and the tick simulation). The fallback ladder is not bound by the budget, so this can exceed it.
- **First from**: the ladder margin that made it. **First rate**: its simulated target rate over the rate asked for (the gate is 0.99).
- **Best footprint**: tiles (area of the box around everything) of the best layout when the budget ran out.
- **Validated**: candidates that passed the static checks; **attempts**: candidates built (ladder rungs and improvement iterations).

Plans: \`processor\` 1 Processor/s on Mk.III assemblers; \`quantum-chip\` 1 Quantum Chip/s on base-tier machines from raw resources;
\`circuit-board\` 1 Circuit Board/s; \`smelter-row\` 12 Iron Ingots/s; \`pls\` Planetary Logistics Station/s (ladder regression check).

`;

const fmt = (v: number | null, digits: number): string => (v === null ? '-' : v.toFixed(digits));

/** One table row for a result. */
export function formatRow(r: BenchResult, meta: { date: string; commit: string; label: string }): string {
  const cells = [
    meta.date,
    meta.commit,
    meta.label || '-',
    r.plan,
    `${r.machines} / ${r.nets}`,
    String(r.budgetS),
    fmt(r.firstValidS, 1),
    r.firstFrom ?? '-',
    fmt(r.firstRatio, 3),
    fmt(r.firstFootprint, 0),
    fmt(r.bestFootprint, 0),
    `${r.validated} / ${r.attempts}`,
    r.stoppedBy,
    fmt(r.wallS, 1),
  ];
  return `| ${cells.join(' | ')} |`;
}

/** Appends `rows` to the doc at `file`, writing the intro and the table header first if the file is new. */
export function appendRows(file: string, rows: string[]): void {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${DOC_INTRO}${TABLE_HEADER.join('\n')}\n`);
  }
  appendFileSync(file, `${rows.join('\n')}\n`);
}

/** The short hash of HEAD, `+dirty` when the app has uncommitted changes; `unknown` outside a repository. */
export function gitCommit(): string {
  try {
    const run = (args: string[]): string => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const head = run(['rev-parse', '--short', 'HEAD']);
    return run(['status', '--porcelain', '--', 'app/src', 'app/scripts']) === '' ? head : `${head}+dirty`;
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------------------------
// Command line

export interface BenchArgs {
  budget: number;
  plans: string[];
  seed: number;
  label: string;
  /** The commit column; empty: HEAD. */
  commit: string;
  out: string;
  write: boolean;
}

export function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { budget: 60, plans: DEFAULT_PLANS, seed: 1, label: '', commit: '', out: DEFAULT_OUT, write: true };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--budget') args.budget = Number(value(i++, flag));
    else if (flag === '--plans') args.plans = value(i++, flag).split(',').map((s) => s.trim()).filter((s) => s !== '');
    else if (flag === '--seed') args.seed = Number(value(i++, flag));
    else if (flag === '--label') args.label = value(i++, flag);
    else if (flag === '--commit') args.commit = value(i++, flag);
    else if (flag === '--out') args.out = resolve(value(i++, flag));
    else if (flag === '--no-write') args.write = false;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!(args.budget > 0)) throw new Error(`--budget must be a positive number of seconds, got ${args.budget}`);
  if (!Number.isInteger(args.seed)) throw new Error(`--seed must be a whole number, got ${args.seed}`);
  for (const p of args.plans) if (!BENCH_PLANS[p]) throw new Error(`unknown plan "${p}"; the plans are: ${Object.keys(BENCH_PLANS).join(', ')}`);
  if (args.plans.length === 0) throw new Error('--plans names no plan');
  return args;
}

/** Runs the plans of `args` in order, logging each result and (unless `--no-write`) appending the rows. */
export async function runBench(args: BenchArgs, log: (line: string) => void = (l) => void process.stdout.write(`${l}\n`)): Promise<BenchResult[]> {
  const meta = { date: new Date().toLocaleDateString('sv-SE'), commit: args.commit || gitCommit(), label: args.label };
  const results: BenchResult[] = [];
  const rows: string[] = [];
  for (const name of args.plans) {
    log(`bench ${name}: ${BENCH_PLANS[name].about}; budget ${args.budget} s, seed ${args.seed}`);
    const r = await benchPlan(name, args.budget, args.seed);
    results.push(r);
    const row = formatRow(r, meta);
    rows.push(row);
    log(row);
  }
  if (args.write) {
    appendRows(args.out, rows);
    log(`appended ${rows.length} row${rows.length === 1 ? '' : 's'} to ${args.out}`);
  }
  return results;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runBench(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
    process.stderr.write(`bench: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
