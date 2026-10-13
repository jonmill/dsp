// What the panels say about a layout that has an export slot for a surplus (Task 30b): the solver gives an item a way out only after a
// deadlock, so the plan shows no such slot until a layout needs one, and then the player is told to drain it.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureGameData } from '../../test/fixtures/fixtureGameData';
import type { SolveResult } from '../lib/layout/solver';
import { stationPairLayout } from '../lib/validate/testkit';
import type { ValidationReport } from '../lib/validate';
import PlanTable from './PlanTable.svelte';
import SolvePanel from './SolvePanel.svelte';
import { createAppState } from './state.svelte';
import type { AppDeps, AppState } from './state.svelte';

// the planner's plan for Iron Ingot, with the iron ore made a candidate for a sink (the target is exported, so it cannot be one)
const { IRON_ORE_ID } = vi.hoisted(() => ({ IRON_ORE_ID: 1001 }));
vi.mock('../lib/calc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/calc')>();
  return {
    ...real,
    planProduction: vi.fn(async (...args: Parameters<typeof real.planProduction>) => {
      const result = await real.planProduction(...args);
      return result.ok ? { ok: true as const, plan: { ...result.plan, surplus: [{ itemId: IRON_ORE_ID, perSecond: 0.5 }] } } : result;
    }),
  };
});

const data = loadFixtureGameData();
const IRON_INGOT = 1101;
const IRON_ORE = 1001;
const passing: ValidationReport = { pass: true, violations: [], checkedAt: '', stage: 'capacity' };
const html = (component: typeof PlanTable, app: AppState): string => render(component, { props: { app } }).body;
const textOf = (fragment: string): string => fragment.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function solved(withSurplusSlot: boolean) {
  let answer!: (result: SolveResult) => void;
  const startSolve: NonNullable<AppDeps['startSolve']> = () => ({ stop: vi.fn(), done: new Promise<SolveResult>((resolve) => (answer = resolve)) });
  const app = createAppState(data, { startSolve });
  app.setTarget(IRON_INGOT);
  await app.whenSettled();
  app.startSolve();
  const pair = stationPairLayout();
  for (const b of pair.kit.buildings) if (b.station) b.station.slots[0].itemId = IRON_INGOT; // no station holds the candidate...
  if (withSurplusSlot) pair.sink.station!.slots[0].itemId = IRON_ORE; // ...unless the layout gave it an export slot
  answer({ layout: pair.kit.layout(), report: passing, footprint: 150, attempts: 3, validated: 1, stoppedBy: 'budget', failures: [] });
  await app.whenSolved();
  return app;
}

describe('a plan with a surplus candidate', () => {
  it('shows no surplus export while there is no layout: the plan\'s slots are those of a plan without sinks', async () => {
    const app = createAppState(data);
    app.setTarget(IRON_INGOT);
    await app.whenSettled();
    const plan = app.plan?.ok ? app.plan.plan : null;
    expect(plan!.surplus).toEqual([{ itemId: IRON_ORE, perSecond: 0.5 }]);
    expect(plan!.stationSlots.some((s) => s.itemId === IRON_ORE && s.role === 'export')).toBe(false);
    expect(textOf(html(PlanTable, app))).not.toContain('for a surplus');
  });

  it('a layout built without the sink says nothing of one', async () => {
    const app = await solved(false);
    expect(textOf(html(SolvePanel, app))).not.toContain('export slot for the surplus');
    expect(textOf(html(PlanTable, app))).not.toContain('for a surplus');
  });

  it('a layout with the sink counts its slot among the item slots and tells the player to drain it', async () => {
    const app = await solved(true);
    const plan = app.plan?.ok ? app.plan.plan : null;
    const solve = textOf(html(SolvePanel, app));
    expect(solve).toContain('This layout ends the belt of Iron Ore at a station, in an export slot for the surplus.');
    expect(solve).toContain('take Iron Ore out of that slot');
    const table = textOf(html(PlanTable, app));
    expect(table).toContain(`${plan!.stationSlots.length + 1} item slots, 1 of them for a surplus`);
  });
});
