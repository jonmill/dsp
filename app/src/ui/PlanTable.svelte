<script lang="ts">
  import type { PlanError, ProductionPlan } from '../lib/calc';
  import { provisionedRate } from '../lib/validate/sim/run';
  import { buildingName, formatCount, formatPercent, formatPower, formatRate, itemName } from './format';
  import ItemIcon from './ItemIcon.svelte';
  import type { AppState } from './state.svelte';

  let { app }: { app: AppState } = $props();

  const result = $derived(app.plan);
  const plan = $derived(result?.ok ? result.plan : null);
  const failure = $derived(result && !result.ok ? result.error : null);
  const unit = $derived(app.rateUnit);
  /** What the plan provisions for the target; the machines are rounded up, so they can make more (`actualTargetRate`). */
  const requested = $derived(plan ? provisionedRate(plan) : 0);
  const hasSpareCapacity = $derived(plan !== null && plan.actualTargetRate > requested * (1 + 1e-9));

  const ERROR_TITLES: Record<PlanError['kind'], string> = {
    'target-locked': 'Target is locked',
    'no-recipe': 'An input cannot be made',
    'facility-unavailable': 'Facility not available',
    infeasible: 'No plan possible',
  };

  /** The item an error is about, if it names one, so the panel can show it. */
  function errorItem(error: PlanError): number | undefined {
    if (error.kind === 'target-locked' || error.kind === 'no-recipe') return error.itemId;
    return undefined;
  }

  /** "Making Processor in Arc Smelter" style detail for a facility error. */
  function facilityDetail(error: Extract<PlanError, { kind: 'facility-unavailable' }>): string {
    const recipe = app.index.data.recipes.find((r) => r.id === error.recipeId);
    const where = error.buildingItemId > 0 ? buildingName(app.index, error.buildingItemId) : 'a suitable facility';
    return `${recipe?.name ?? `recipe ${error.recipeId}`} needs ${where}`;
  }

  function powerParts(plan: ProductionPlan): { label: string; watts: number }[] {
    const p = plan.power;
    return [
      { label: 'Production (working)', watts: p.productionWorkW },
      { label: 'Production (idle)', watts: p.productionIdleW },
      { label: 'Sorters (estimate)', watts: p.sortersW },
      { label: 'Spray coaters (estimate)', watts: p.coatersW },
      { label: 'Station charging (full rate)', watts: p.stationChargeW },
    ];
  }
</script>

<section class="card" aria-labelledby="plan-title">
  <h2 id="plan-title">
    <span class="grow">Production plan</span>
    {#if app.computing}<span class="busy">updating...</span>{/if}
  </h2>

  <!-- The only live region: the status line is announced when it changes, the tables are not. -->
  <div aria-live="polite" aria-atomic="true">
    {#if !app.hasTarget}
      <p class="hint">Pick a target item to see what it takes to build it.</p>
    {:else if result === null}
      <p class="hint">Planning...</p>
    {:else if plan}
      <div class="summary">
        <span>
          <strong>{formatRate(requested, unit)}</strong>
          {itemName(app.index, plan.request.targetItemId)} requested
          {#if hasSpareCapacity}
            <span class="muted">&middot; up to {formatRate(plan.actualTargetRate, unit)} capacity</span>
          {/if}
        </span>
        <span class="muted">
          {plan.stages.reduce((n, s) => n + s.machines, 0)} machines,
          {plan.stationsNeeded} station{plan.stationsNeeded === 1 ? '' : 's'}
          ({plan.stationSlots.length} item slot{plan.stationSlots.length === 1 ? '' : 's'})
        </span>
      </div>
    {/if}
  </div>

  {#if failure}
    {@const itemId = errorItem(failure)}
    <div class="callout error" role="alert">
      <strong>{ERROR_TITLES[failure.kind]}</strong>
      {#if itemId !== undefined}
        <div class="subject">
          <ItemIcon index={app.index} itemId={itemId} size={20} />
          <span>{itemName(app.index, itemId)}</span>
        </div>
      {:else if failure.kind === 'facility-unavailable'}
        <div class="subject">{facilityDetail(failure)}</div>
      {/if}
      <p>{failure.message}</p>
    </div>
  {:else if plan}
    {#if plan.warnings.length > 0}
      <div class="callout warn" role="status">
        <ul>
          {#each plan.warnings as warning, i (i)}
            <li>{warning}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Recipe</th>
            <th>Facility</th>
            <th class="r">Machines</th>
            <th class="r">Utilization</th>
            <th>Makes</th>
          </tr>
        </thead>
        <tbody>
          {#each plan.stages as stage (stage.recipeId)}
            {@const recipe = app.index.recipe(stage.recipeId)}
            <tr>
              <td>
                <span class="cell">
                  <ItemIcon index={app.index} itemId={recipe.outputs[0]?.itemId ?? 0} size={20} />
                  <span>
                    {recipe.name}
                    {#if stage.proliferated}<span class="tag" title="Inputs are sprayed with proliferator">prolif.</span>{/if}
                  </span>
                </span>
              </td>
              <td>
                <span class="cell">
                  <ItemIcon index={app.index} itemId={stage.buildingItemId} size={20} />
                  <span>{buildingName(app.index, stage.buildingItemId)}</span>
                </span>
              </td>
              <td class="r num">
                <strong>{stage.machines}</strong>
                <span class="muted">({formatCount(stage.exactMachines)})</span>
              </td>
              <td class="r num">
                <span class="util" style:--fill="{Math.min(100, stage.utilization * 100)}%"></span>
                {formatPercent(stage.utilization)}
              </td>
              <td class="num">
                {#each stage.outputs as out, i (out.itemId)}
                  {#if i > 0}, {/if}{itemName(app.index, out.itemId)}
                  <span class="muted">{formatRate(out.perSecond, unit)}</span>
                {/each}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="flows">
      <div>
        <h3>Imports</h3>
        {#if plan.imports.length === 0}
          <p class="hint">Nothing: every input is made.</p>
        {:else}
          <ul>
            {#each plan.imports as item (item.itemId)}
              <li>
                <ItemIcon index={app.index} itemId={item.itemId} size={18} />
                <span class="grow">{itemName(app.index, item.itemId)}</span>
                <span class="num">{formatRate(item.perSecond, unit)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      <div>
        <h3>Exports</h3>
        <ul>
          {#each plan.exports as item, i (item.itemId)}
            <li>
              <ItemIcon index={app.index} itemId={item.itemId} size={18} />
              <span class="grow">{itemName(app.index, item.itemId)}</span>
              {#if i > 0}<span class="tag" title="By-product nothing in the plan consumes">by-product</span>{/if}
              <span class="num">{formatRate(item.perSecond, unit)}</span>
            </li>
          {/each}
        </ul>
      </div>
    </div>

    <div class="power">
      <h3>Power estimate</h3>
      <div class="totals">
        <div>
          <span class="muted">Steady</span>
          <strong class="num">{formatPower(plan.power.steadyW)}</strong>
        </div>
        <div>
          <span class="muted">Peak</span>
          <strong class="num">{formatPower(plan.power.peakW)}</strong>
        </div>
      </div>
      <ul class="parts">
        {#each powerParts(plan) as part (part.label)}
          <li>
            <span class="grow muted">{part.label}</span>
            <span class="num">{formatPower(part.watts)}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .grow {
    flex: 1;
    min-width: 0;
  }

  .busy {
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    color: var(--accent);
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 4px 16px;
    margin-bottom: 10px;
    font-size: 14px;
  }

  .callout {
    margin-bottom: 10px;
  }

  .callout p {
    margin: 4px 0 0;
  }

  .callout ul {
    margin: 0;
    padding-left: 16px;
  }

  .subject {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    font-weight: 600;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    text-align: left;
    vertical-align: middle;
  }

  thead th {
    border-top: 0;
    background: var(--surface-2);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .r {
    text-align: right;
    white-space: nowrap;
  }

  .cell {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .util {
    display: inline-block;
    width: 36px;
    height: 6px;
    margin-right: 6px;
    border-radius: 3px;
    background: linear-gradient(to right, var(--accent) var(--fill), var(--surface-3) var(--fill));
    vertical-align: middle;
  }

  .tag {
    margin-left: 4px;
    padding: 0 5px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-size: 10px;
    font-weight: 600;
  }

  .flows {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 16px;
    margin-top: 14px;
  }

  h3 {
    margin-bottom: 4px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .flows ul,
  .parts {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .flows li,
  .parts li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    border-top: 1px solid var(--border);
  }

  .flows li:first-child,
  .parts li:first-child {
    border-top: 0;
  }

  .power {
    margin-top: 14px;
  }

  .totals {
    display: flex;
    gap: 32px;
    margin-bottom: 6px;
  }

  .totals div {
    display: flex;
    flex-direction: column;
  }

  .totals strong {
    font-size: 18px;
  }
</style>
