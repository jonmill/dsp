// The panels rendered on the server side of Svelte (no DOM in the tests): what the user is told for a given solve.
// Review Focus #5: a blueprint built on approximate geometry is shown with a visible "approximate / unverified" flag.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureGameData } from '../../test/fixtures/fixtureGameData';
import type { SolveResult } from '../lib/layout/solver';
import { compositeLayout, stationPairLayout } from '../lib/validate/testkit';
import type { ValidationReport } from '../lib/validate';
import { formatPower } from './format';
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

/** The text of a rendered fragment: comments and tags gone, white space collapsed. */
const textOf = (fragment: string): string =>
  fragment.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** The table row whose header cell starts with `label`, as text: its header and its value cells, with no markup in them. */
function tableRow(page: string, label: string): { header: string; cells: string[] } {
  for (const [, row] of page.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const header = /<th\b[^>]*>([\s\S]*?)<\/th>/.exec(row);
    if (header && textOf(header[1]).startsWith(label)) {
      return { header: textOf(header[1]), cells: [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => textOf(m[1])) };
    }
  }
  throw new Error(`no table row labelled "${label}"`);
}

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
    // the plan estimate counts the 8 coaters of the layout (one per sprayed belt), not the plan's own one per sprayed item
    expect(page).toContain('Plan estimate (with the 8 spray coaters and the 1 station of this layout)');
    const bare = await appWith(undefined, { ...passing, stage: 'simulation', sim: simulated(1) });
    await bare.finish();
    const plain = html(ValidationPanel, bare.app);
    expect(plain).toContain('Capacity (simulated)');
    expect(plain).not.toContain('Spray coaters');
    expect(plain).toContain('Plan estimate (with the 1 station of this layout)');
  });

  it('puts the stations of the layout into the plan estimate: the plan counts 1 station, the layout has 2 Interstellar ones (60 MW each)', async () => {
    const pair = stationPairLayout();
    for (const b of pair.kit.buildings) if (b.station) b.station.chargePerTick = 1_000_000;
    const report: ValidationReport = { ...passing, stage: 'simulation', sim: simulated(1) };
    const { app, finish } = await appWith(pair.kit.layout(), report);
    await finish();
    const plan = app.solve.plan!;
    expect(plan.stationsNeeded).toBe(1);
    const page = html(ValidationPanel, app);
    expect(page).toContain('Plan estimate (with the 2 stations of this layout)');
    // 12 MW for the one station the plan counts becomes 120 MW: peak + 108 MW, steady + 10.8 MW. The row of the estimate holds exactly
    // those two values (the plan's own peak is not among them), and the measured row beside it is the simulation's.
    const estimate = tableRow(page, 'Plan estimate');
    expect(estimate.header).toBe('Plan estimate (with the 2 stations of this layout)');
    expect(estimate.cells).toEqual([formatPower(plan.power.steadyW + 10.8e6), formatPower(plan.power.peakW + 108e6)]);
    expect(estimate.cells).not.toContain(formatPower(plan.power.peakW));
    expect(tableRow(page, 'Measured').cells).toEqual([formatPower(1_500_000), formatPower(4_000_000)]);
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

  it('marks the machines the headroom added, and only those', async () => {
    const app = createAppState(data);
    app.setTarget(IRON_INGOT);
    app.setFinalFacility(2302); // Arc Smelter: 1 Iron Ingot/s each
    app.setQuantity({ kind: 'rate', perSecond: 2 });
    await app.whenSettled();
    const plan = app.plan?.ok ? app.plan.plan : null;
    const stage = plan!.stages[0];
    expect(stage.exactMachines).toBeCloseTo(2, 6); // 2 smelters would run at 100 %
    expect(stage.machines).toBe(3);
    const page = html(PlanTable, app);
    expect(page).toContain('+1 headroom');
    expect(page.match(/\+\d+ headroom/g)).toEqual(['+1 headroom']); // the smelter stage only
    app.setMachineHeadroom(0);
    await app.whenSettled();
    expect(html(PlanTable, app)).not.toContain('headroom');
  });

  it('does not mark the target stage of a buildings request', async () => {
    const app = createAppState(data);
    app.setTarget(IRON_INGOT);
    app.setFinalFacility(2302);
    app.setQuantity({ kind: 'buildings', count: 2 });
    await app.whenSettled();
    const plan = app.plan?.ok ? app.plan.plan : null;
    expect(plan!.stages[0].machines).toBe(2);
    expect(html(PlanTable, app)).not.toContain('headroom');
  });

  it('calls the station count a plan estimate before a solve, and shows the layout\'s once there is one', async () => {
    const flat = (component: typeof PlanTable, app: AppState): string => html(component, app).replace(/\s+/g, ' ');
    const { app, finish } = await appWith();
    const before = flat(PlanTable, app);
    expect(before).toContain('1 station (plan estimate,');
    expect(before).not.toContain('in the layout');
    // the layout has 2 Interstellar stations of 60 MW; the plan counted 1 Planetary one of 12 MW
    const pair = stationPairLayout();
    for (const b of pair.kit.buildings) if (b.station) b.station.chargePerTick = 1_000_000;
    await finish({ layout: pair.kit.layout() });
    const plan = app.plan?.ok ? app.plan.plan : null;
    expect(plan!.stationsNeeded).toBe(1);
    const after = flat(PlanTable, app);
    expect(after).toContain('2 stations in the layout');
    expect(after).not.toContain('plan estimate');
    expect(after).toContain('Station charging (full rate, 2 in the layout)');
    expect(after).toContain(formatPower(plan!.power.peakW + 108e6));
    expect(after).toContain(formatPower(120e6));
    // the plan changes: the layout is for an older plan, and the table goes back to what the plan says
    app.setQuantity({ kind: 'rate', perSecond: 2 });
    await app.whenSettled();
    const later = flat(PlanTable, app);
    expect(later).toContain('station (plan estimate,');
    expect(later).not.toContain('in the layout');
    expect(later).toContain('Station charging (full rate, plan estimate)');
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

  it('offers the machine headroom as a percentage, 1 by default, and shows what was set', async () => {
    const { app } = await appWith();
    const input = (): string => render(OptionsPanel, { props: { app } }).body.match(/<input[^>]*aria-label="Machine headroom"[^>]*>/)?.[0] ?? '';
    expect(input()).toContain('type="number"');
    expect(input()).toContain('min="0"');
    expect(input()).toContain('max="10"');
    expect(input()).toContain('value="1"');
    app.setMachineHeadroom(0.075);
    expect(input()).toContain('value="7.5"');
    app.setMachineHeadroom(0);
    expect(input()).toContain('value="0"');
  });

  it('shows the box checked once the option is on', async () => {
    const { app } = await appWith();
    app.setUseUnverifiedMotifs(true);
    const page = render(OptionsPanel, { props: { app } }).body;
    expect(page).toMatch(/<input[^>]*type="checkbox"[^>]*\bchecked\b/);
  });
});
