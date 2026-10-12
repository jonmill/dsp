<script lang="ts">
  import { withCoaters } from '../lib/calc';
  import type { Violation } from '../lib/validate';
  import { provisionedRate } from '../lib/validate/sim/run';
  import { formatPercent, formatPower, formatRate } from './format';
  import type { AppState } from './state.svelte';

  let { app }: { app: AppState } = $props();

  const report = $derived(app.solve.report);
  const plan = $derived(app.solve.plan);
  const sim = $derived(report?.sim ?? null);
  const provisioned = $derived(plan ? provisionedRate(plan) : 0);
  const capacity = $derived(sim?.measuredTargetRate ?? 0);
  /** Only the validator's own verdict makes the figure a problem; more than the provisioned rate is normal. */
  const rateLow = $derived(report?.violations.some((v) => v.code === 'SIM_OUTPUT_LOW') ?? false);
  /** The plan's power estimate with the layout's own spray coaters (one per sprayed belt) in place of the plan's (one per sprayed item). */
  const estimate = $derived(plan && sim ? withCoaters(plan.power, sim.coaters.count, app.index) : null);

  const STAGES = { geometry: 'geometry rules', capacity: 'belt and sorter capacity', simulation: 'tick simulation' } as const;

  /** One line for the entities a violation is about. */
  function entityText(violation: Violation): string {
    return violation.entities.map((e) => `${e.kind} ${e.id}${e.node === undefined ? '' : `.${e.node}`}`).join(', ');
  }
</script>

<section class="card" aria-labelledby="validation-title">
  <h2 id="validation-title">Validation</h2>

  {#if !report}
    <p class="hint">
      {app.solve.status === 'idle' ? 'Solve a plan to validate its layout.' : 'No layout has passed the validator yet.'}
    </p>
  {:else}
    <div class="verdict" class:pass={report.pass} class:fail={!report.pass} role="status">
      <strong>{report.pass ? 'PASS' : 'FAIL'}</strong>
      <span>
        {report.pass
          ? sim
            ? 'every check passed, simulation included'
            : 'static checks passed; the simulation did not run'
          : `failed at the ${STAGES[report.stage]}`}
      </span>
    </div>

    {#if sim && plan}
      <div class="compare">
        <h3>Target rate</h3>
        <div class="figures">
          <div>
            <span class="muted">Capacity (simulated)</span>
            <strong class="num" class:bad={rateLow}>{formatRate(capacity, 's')}</strong>
          </div>
          <div>
            <span class="muted">Provisioned</span>
            <strong class="num">{formatRate(provisioned, 's')}</strong>
          </div>
          <div>
            <span class="muted">Capacity / provisioned</span>
            <strong class="num" class:bad={rateLow}>{provisioned > 0 ? formatPercent(capacity / provisioned) : '-'}</strong>
          </div>
        </div>
        <p class="hint">
          The simulation runs every machine flat out against unlimited station supply, so the capacity is what this
          layout can deliver, not what the plan asks for. The check is that it reaches the provisioned rate (within the
          validator's tolerance, about 1 %); more is normal.
        </p>
        <p class="hint">
          Measured over {sim.measureSeconds} s after a {Math.round(sim.warmupTicksUsed / 60)} s warm-up (game time).
        </p>

        {#if sim.coaters.count > 0}
          <h3>Proliferator</h3>
          <div class="figures">
            <div>
              <span class="muted">Spray coaters</span>
              <strong class="num">{sim.coaters.count}</strong>
            </div>
            <div>
              <span class="muted">Used (simulated)</span>
              <strong class="num">{formatRate(sim.coaters.proliferatorPerSecond, 's')}</strong>
            </div>
            <div>
              <span class="muted">Plan</span>
              <strong class="num">{formatRate(plan.proliferatorPerSecond, 's')}</strong>
            </div>
          </div>
          <p class="hint">
            A coater sprays everything that passes it, including what goes on to the stations, and the machines the plan
            rounded up work at full speed, so the simulated use can exceed the plan's.
          </p>
        {/if}

        <h3>Power</h3>
        <table>
          <thead>
            <tr><th></th><th class="r">Steady</th><th class="r">Peak</th></tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Measured</th>
              <td class="r num">{formatPower(sim.power.steadyW)}</td>
              <td class="r num">{formatPower(sim.power.peakW)}</td>
            </tr>
            <tr>
              <th scope="row">Plan estimate{sim.coaters.count > 0 ? ` (with the ${sim.coaters.count} spray coaters of this layout)` : ''}</th>
              <td class="r num">{formatPower(estimate?.steadyW ?? plan.power.steadyW)}</td>
              <td class="r num">{formatPower(estimate?.peakW ?? plan.power.peakW)}</td>
            </tr>
          </tbody>
        </table>
        <p class="hint">
          Peak includes {formatPower(sim.power.stationChargeW)} of stations charging from empty.
        </p>
      </div>
    {/if}

    {#if report.violations.length > 0}
      <h3>{report.violations.length} violation{report.violations.length === 1 ? '' : 's'}</h3>
      <ul class="violations scroll">
        {#each report.violations as violation, i (i)}
          <li>
            <button
              type="button"
              class="violation"
              aria-pressed={app.selectedViolation === violation}
              onclick={() => app.selectViolation(app.selectedViolation === violation ? null : violation)}
            >
              <span class="code num">{violation.code}</span>
              <span class="text">{violation.message}</span>
              <span class="who muted">{entityText(violation)}</span>
            </button>
          </li>
        {/each}
      </ul>
      <p class="hint">Pick one to centre it in the preview and draw it in red.</p>
    {:else}
      <p class="hint">No violations.</p>
    {/if}
  {/if}
</section>

<style>
  .verdict {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .verdict strong {
    font-size: 16px;
    letter-spacing: 0.04em;
  }

  .verdict.pass {
    border-color: var(--ok);
    background: var(--ok-soft);
    color: var(--ok);
  }

  .verdict.fail {
    border-color: var(--danger-border);
    background: var(--danger-soft);
    color: var(--danger);
  }

  h3 {
    margin: 14px 0 4px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .figures {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 32px;
  }

  .figures div {
    display: flex;
    flex-direction: column;
  }

  .figures strong {
    font-size: 18px;
  }

  .bad {
    color: var(--danger);
  }

  table {
    border-collapse: collapse;
  }

  th,
  td {
    padding: 3px 24px 3px 0;
    text-align: left;
    font-weight: 400;
  }

  thead th {
    font-size: 11px;
    color: var(--text-dim);
  }

  tbody th {
    color: var(--text-dim);
  }

  .r {
    text-align: right;
  }

  .compare .hint {
    margin-top: 4px;
  }

  .violations {
    max-height: 260px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .violations li + li {
    border-top: 1px solid var(--border);
  }

  .violation {
    display: grid;
    gap: 2px;
    width: 100%;
    height: auto;
    padding: 6px 10px;
    border: 0;
    border-radius: 0;
    background: transparent;
    text-align: left;
    white-space: normal;
  }

  .violation[aria-pressed='true'] {
    background: var(--danger-soft);
    box-shadow: inset 3px 0 0 var(--danger);
  }

  .code {
    font-size: 11px;
    font-weight: 600;
    color: var(--danger);
  }

  .who {
    font-size: 11px;
  }
</style>
