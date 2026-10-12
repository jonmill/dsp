// The panels rendered on the server side of Svelte (no DOM in the tests): what the user is told for a given solve.
// Review Focus #5: a blueprint built on approximate geometry is shown with a visible "approximate / unverified" flag.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureGameData } from '../../test/fixtures/fixtureGameData';
import type { SolveResult } from '../lib/layout/solver';
import { compositeLayout } from '../lib/validate/testkit';
import type { ValidationReport } from '../lib/validate';
import BlueprintPanel from './BlueprintPanel.svelte';
import OptionsPanel from './OptionsPanel.svelte';
import PlanTable from './PlanTable.svelte';
import SolvePanel from './SolvePanel.svelte';
import { createAppState } from './state.svelte';
import type { AppDeps, AppState } from './state.svelte';
import ValidationPanel from './ValidationPanel.svelte';

const data = loadFixtureGameData();
const IRON_INGOT = 1101;
const CIRCUIT_BOARD = 1301;
const EQUATOR_NOTE = 'Paste within the equatorial band (±28° latitude); pasting near the poles may fail';

const passing: ValidationReport = { pass: true, violations: [], checkedAt: '2026-01-01T00:00:00Z', stage: 'capacity' };

/** An app with Iron Ingot planned and a solver the test answers by hand. */
async function appWith(layout = compositeLayout().kit.layout(), report: ValidationReport = passing) {
  let answer!: (result: SolveResult) => void;
  const startSolve: NonNullable<AppDeps['startSolve']> = () => ({
    stop: vi.fn(),
    done: new Promise<SolveResult>((resolve) => (answer = resolve)),
  });
  const app = createAppState(data, { startSolve });
  app.setTarget(IRON_INGOT);
  await app.whenSettled();
  app.startSolve();
  return {
    app,
    finish: async (result: Partial<SolveResult> = {}) => {
      answer({ layout, report, footprint: 150, attempts: 4, validated: 2, stoppedBy: 'budget', failures: [], ...result });
      await app.whenSolved();
    },
  };
}

const html = (component: typeof BlueprintPanel, app: AppState): string => render(component, { props: { app } }).body;

describe('BlueprintPanel', () => {
  it('always carries the equatorial band note, even before there is a blueprint', async () => {
    const { app } = await appWith();
    expect(app.blueprint).toBeNull();
    expect(html(BlueprintPanel, app)).toContain(EQUATOR_NOTE);
  });

  it('shows the blueprint string in a read-only textarea, and the buttons', async () => {
    const { app, finish } = await appWith();
    await finish();
    const page = html(BlueprintPanel, app);
    expect(page).toMatch(/<textarea[^>]*\breadonly\b/);
    expect(page).toContain('BLUEPRINT:0,10,1101');
    expect(page).toContain('Copy');
    expect(page).toContain('Download .txt');
    expect(page).toContain('iron-ingot-1.txt');
    expect(page).toContain(EQUATOR_NOTE);
  });

  it('warns that the geometry is approximate when the layout was built on approximate geometry', async () => {
    const { app, finish } = await appWith();
    await finish();
    expect(app.solve.layout?.meta.geometrySource).toBe('approximate');
    const page = html(BlueprintPanel, app);
    expect(page).toContain('Geometry: approximate - unverified in game');
    expect(page).toContain('role="note"');
  });

  it('does not warn about extracted geometry', async () => {
    const layout = compositeLayout().kit.layout();
    layout.meta.geometrySource = 'extracted';
    const { app, finish } = await appWith(layout);
    await finish();
    expect(html(BlueprintPanel, app)).not.toContain('approximate');
  });

  it('says the blueprint is for an earlier plan once the plan has changed', async () => {
    const { app, finish } = await appWith();
    await finish();
    expect(html(BlueprintPanel, app)).not.toContain('earlier plan');
    app.setQuantity({ kind: 'rate', perSecond: 2 });
    await app.whenSettled();
    expect(html(BlueprintPanel, app)).toContain('earlier plan');
  });
});

describe('ValidationPanel', () => {
  const simulated = (measuredTargetRate: number): ValidationReport['sim'] => ({
    measuredTargetRate,
    measuredExports: [],
    machineStats: [],
    stageStats: [],
    deadlocked: false,
    power: { steadyW: 1_500_000, idleW: 0, peakW: 4_000_000, stationChargeW: 2_000_000 },
    coaters: { count: 0, sprayedItems: 0, proliferatorPerSecond: 0 },
    measureSeconds: 300,
    warmupTicksUsed: 7200,
    warnings: [],
  });

  it('shows the spray coaters and the proliferator they used next to the plan\'s, only when there are coaters', async () => {
    const sprayed = { ...simulated(1)!, coaters: { count: 8, sprayedItems: 6000, proliferatorPerSecond: 0.32 } };
    const report: ValidationReport = { ...passing, stage: 'simulation', sim: sprayed };
    const { app, finish } = await appWith(undefined, report);
    await finish();
    const page = html(ValidationPanel, app);
    expect(page).toContain('Proliferator');
    expect(page).toContain('Spray coaters');
    expect(page).toContain('Used (simulated)');
    const bare = await appWith(undefined, { ...passing, stage: 'simulation', sim: simulated(1) });
    await bare.finish();
    const plain = html(ValidationPanel, bare.app);
    expect(plain).toContain('Capacity (simulated)');
    expect(plain).not.toContain('Spray coaters');
  });

  it('says PASS with the simulated capacity next to the provisioned rate, and the measured power next to the estimate', async () => {
    const report: ValidationReport = { ...passing, stage: 'simulation', sim: simulated(1) };
    const { app, finish } = await appWith(undefined, report);
    await finish();
    const page = html(ValidationPanel, app);
    expect(page).toContain('PASS');
    expect(page).toContain('Capacity (simulated)');
    expect(page).toContain('Provisioned');
    expect(page).toContain('1/s');
    expect(page).toContain('1.50 MW');
    expect(page).toContain('4.00 MW');
    expect(page).toContain('Plan estimate');
    expect(page).toContain('No violations');
  });

  it('explains that the simulation runs flat out on unlimited supply, and does not flag more than the provisioned rate', async () => {
    // 3/s simulated against 1/s provisioned: the layout has spare capacity, which is normal.
    const report: ValidationReport = { ...passing, stage: 'simulation', sim: simulated(3) };
    const { app, finish } = await appWith(undefined, report);
    await finish();
    const page = html(ValidationPanel, app);
    expect(page).toContain('flat out against unlimited station supply');
    expect(page).toContain('300%');
    expect(page).not.toContain('bad');
  });

  it('flags the capacity only when the validator found it too low', async () => {
    const report: ValidationReport = {
      pass: false,
      violations: [{ code: 'SIM_OUTPUT_LOW', entities: [], message: 'Iron Ingot reached the stations at 0.5/s' }],
      checkedAt: '2026-01-01T00:00:00Z',
      stage: 'simulation',
      sim: simulated(0.5),
    };
    const { app, finish } = await appWith(undefined, report);
    await finish();
    expect(html(ValidationPanel, app)).toContain('bad');
  });

  it('says FAIL and lists the violations', async () => {
    const report: ValidationReport = {
      pass: false,
      violations: [{ code: 'BELT_OVERLAP', entities: [{ kind: 'belt', id: 3, node: 2 }], message: 'belt 3 crosses belt 4' }],
      checkedAt: '2026-01-01T00:00:00Z',
      stage: 'geometry',
    };
    const { app, finish } = await appWith(undefined, report);
    await finish();
    const page = html(ValidationPanel, app);
    expect(page).toContain('FAIL');
    expect(page).toContain('BELT_OVERLAP');
    expect(page).toContain('belt 3 crosses belt 4');
    expect(page).toContain('belt 3.2');
  });

  it('asks for a solve before there is a report', async () => {
    const app = createAppState(data);
    expect(html(ValidationPanel, app)).toContain('Solve a plan');
  });
});

describe('PlanTable', () => {
  it('says what was requested and, apart from it, the capacity the rounded-up machines have', async () => {
    const app = createAppState(data);
    app.setTarget(CIRCUIT_BOARD);
    await app.whenSettled();
    const plan = app.plan?.ok ? app.plan.plan : null;
    expect(plan!.actualTargetRate).toBeGreaterThan(1.5); // a Re-composing Assembler makes far more than 1/s
    const page = html(PlanTable, app);
    expect(page).toMatch(/<strong>1\/s<\/strong>\s*Circuit Board requested/);
    expect(page).toContain(`up to ${+plan!.actualTargetRate.toFixed(3)}/s capacity`);
  });

  it('shows no capacity when the machines make exactly what was requested', async () => {
    const app = createAppState(data);
    app.setTarget(IRON_INGOT);
    app.setQuantity({ kind: 'buildings', count: 1 });
    await app.whenSettled();
    const plan = app.plan?.ok ? app.plan.plan : null;
    expect(plan!.actualTargetRate).toBeCloseTo(plan!.exports[0].perSecond, 9);
    expect(html(PlanTable, app)).not.toContain('capacity');
  });
});

describe('SolvePanel', () => {
  it('disables Solve without a plan and says why', () => {
    const app = createAppState(data);
    const page = html(SolvePanel, app);
    expect(page).toMatch(/<button[^>]*disabled[^>]*>\s*Solve\s*</);
    expect(page).toContain('Pick a target');
  });

  it('shows progress while solving and the stale banner after the plan changes', async () => {
    const { app, finish } = await appWith();
    expect(html(SolvePanel, app)).toContain('Looking for a first valid layout');
    expect(html(SolvePanel, app)).toContain('Restart');
    await finish();
    expect(html(SolvePanel, app)).toContain('Time budget reached');
    app.setQuantity({ kind: 'rate', perSecond: 2 });
    await app.whenSettled();
    expect(html(SolvePanel, app)).toContain('The plan changed after this solve started');
  });

  it('lists why the solver found nothing', async () => {
    const { app, finish } = await appWith();
    await finish({ layout: null, report: null, footprint: null, stoppedBy: 'exhausted', failures: ['BELT_OVERLAP: boom'] });
    const page = html(SolvePanel, app);
    expect(page).toContain('No valid layout was found');
    expect(page).toContain('BELT_OVERLAP: boom');
  });

  it('shows the error of a failed solver', async () => {
    const startSolve: NonNullable<AppDeps['startSolve']> = () => {
      throw new Error('Worker is not defined');
    };
    const app = createAppState(data, { startSolve });
    app.setTarget(IRON_INGOT);
    await app.whenSettled();
    app.startSolve();
    expect(html(SolvePanel, app)).toContain('Worker is not defined');
  });
});

describe('OptionsPanel', () => {
  it('offers the dense motifs as an unchecked option, labelled as not yet verified in game', async () => {
    const { app } = await appWith();
    const page = render(OptionsPanel, { props: { app } }).body;
    expect(page).toContain('Use dense motifs not yet verified in-game');
    expect(page).toMatch(/<input[^>]*type="checkbox"[^>]*>/);
    expect(page).not.toMatch(/<input[^>]*type="checkbox"[^>]*\bchecked\b/);
  });

  it('shows the box checked once the option is on', async () => {
    const { app } = await appWith();
    app.setUseUnverifiedMotifs(true);
    const page = render(OptionsPanel, { props: { app } }).body;
    expect(page).toMatch(/<input[^>]*type="checkbox"[^>]*\bchecked\b/);
  });
});
