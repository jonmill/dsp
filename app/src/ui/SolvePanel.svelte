<script lang="ts">
  import type { SolveResult } from '../lib/layout/solver';
  import { formatCount, formatDuration, noLayoutMessage } from './format';
  import type { AppState } from './state.svelte';

  let { app }: { app: AppState } = $props();

  const solve = $derived(app.solve);
  const running = $derived(solve.status === 'running');

  // The solver reports after every candidate, which can be seconds apart; this clock keeps the elapsed time moving.
  let now = $state(performance.now());
  $effect(() => {
    if (!running) return;
    now = performance.now();
    const timer = setInterval(() => (now = performance.now()), 250);
    return () => clearInterval(timer);
  });

  const elapsedMs = $derived(running ? Math.max(0, now - solve.startedAt) : (solve.progress?.elapsedMs ?? 0));
  const share = $derived(solve.budgetMs > 0 ? Math.min(1, elapsedMs / solve.budgetMs) : 0);
  const footprint = $derived(solve.progress?.bestFootprint ?? solve.footprint);

  const STOPPED: Record<SolveResult['stoppedBy'], string> = {
    budget: 'Time budget reached.',
    early: 'No improvement in the last fifth of the run, so it stopped early.',
    user: 'Stopped by you.',
    exhausted: 'No valid layout was found.',
  };

  // A solve that ended with no layout says why and what to try, with the size of the plan it was for.
  const noLayout = $derived.by(() => {
    const result = solve.status === 'done' ? solve.result : null;
    const plan = solve.plan;
    if (!result || result.layout || !plan) return null;
    const machines = plan.stages.reduce((n, stage) => n + stage.machines, 0);
    const proliferated = plan.request.proliferator.tier !== 0 && plan.proliferatorPerSecond > 0;
    return noLayoutMessage(result.stoppedBy, machines, proliferated);
  });

  const blockedReason = $derived(
    app.canSolve
      ? ''
      : app.computing
        ? 'Updating the plan...'
        : 'Pick a target with a feasible plan to solve its layout.',
  );
</script>

<section class="card" aria-labelledby="solve-title">
  <h2 id="solve-title">
    <span class="grow">Layout solver</span>
    {#if running}<span class="busy">{solve.stopping ? 'stopping...' : 'solving...'}</span>{/if}
  </h2>

  {#if solve.stale}
    <div class="callout warn" role="status">
      <strong>The plan changed after this solve started.</strong>
      The layout, report and blueprint below are for the earlier plan. Solve again to update them.
    </div>
  {/if}

  <div class="controls">
    <button type="button" class="primary" disabled={!app.canSolve} onclick={() => app.startSolve()}>
      {running ? 'Restart' : 'Solve'}
    </button>
    <button type="button" disabled={!running || solve.stopping} onclick={() => app.stopSolve()}>
      Stop &amp; use best
    </button>
    <span class="muted budget">
      Time budget <strong class="num">{formatCount(app.solverBudgetMinutes)} min</strong>
      <span class="hint">(set in Options)</span>
    </span>
  </div>
  {#if blockedReason}<p class="hint">{blockedReason}</p>{/if}

  <div aria-live="polite" aria-atomic="true">
    {#if running}
      <div
        class="bar"
        role="progressbar"
        aria-label="Time budget used"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(share * 100)}
      >
        <span style:width="{share * 100}%"></span>
      </div>
    {/if}

    {#if solve.status === 'error'}
      <div class="callout error" role="alert">
        <strong>The solver failed.</strong>
        <p>{solve.error}</p>
      </div>
    {:else if solve.status !== 'idle'}
      {#if solve.status === 'done' && solve.result}
        {#if noLayout}
          <div class="callout warn" role="status">{noLayout}</div>
        {:else}
          <p class="outcome">
            {STOPPED[solve.result.stoppedBy]}
            {#if solve.result.layout}Best layout covers {formatCount(solve.result.footprint ?? 0)} tiles.{/if}
          </p>
        {/if}
      {:else if running && !solve.layout}
        <p class="outcome muted">Looking for a first valid layout...</p>
      {/if}
    {/if}
  </div>

  {#if solve.status !== 'idle'}
    <dl class="stats">
      <div>
        <dt>Elapsed</dt>
        <dd class="num">{formatDuration(elapsedMs)}{#if running} / {formatDuration(solve.budgetMs)}{/if}</dd>
      </div>
      <div>
        <dt>Attempts</dt>
        <dd class="num">{solve.progress?.attempts ?? 0}</dd>
      </div>
      <div>
        <dt>Validated</dt>
        <dd class="num">{solve.progress?.validated ?? 0}</dd>
      </div>
      <div>
        <dt>Best footprint</dt>
        <dd class="num">{footprint === null ? '-' : `${formatCount(footprint)} tiles`}</dd>
      </div>
    </dl>
    {#if running && solve.progress}
      <p class="phase muted num" title={solve.progress.lastFailure ?? ''}>
        {solve.progress.phase}{#if solve.progress.lastFailure}: {solve.progress.lastFailure}{/if}
      </p>
    {/if}
  {/if}

  {#if solve.result && solve.result.failures.length > 0}
    <details class="failures">
      <summary>{solve.result.failures.length} message{solve.result.failures.length === 1 ? '' : 's'} from the solver</summary>
      <ul class="scroll">
        {#each solve.result.failures as failure, i (i)}
          <li>{failure}</li>
        {/each}
      </ul>
    </details>
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

  .callout {
    margin-bottom: 10px;
  }

  .callout p {
    margin: 4px 0 0;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }

  .budget {
    margin-left: auto;
  }

  .hint {
    margin-top: 6px;
  }

  .bar {
    height: 6px;
    margin-top: 10px;
    border-radius: 3px;
    background: var(--surface-3);
    overflow: hidden;
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.25s linear;
  }

  .outcome {
    margin: 10px 0 0;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 8px 16px;
    margin: 10px 0 0;
  }

  .stats div {
    display: flex;
    flex-direction: column;
  }

  dt {
    font-size: 11px;
    color: var(--text-dim);
  }

  dd {
    margin: 0;
    font-size: 15px;
  }

  .phase {
    margin: 8px 0 0;
    overflow: hidden;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .failures {
    margin-top: 10px;
  }

  .failures summary {
    cursor: pointer;
    color: var(--text-dim);
  }

  .failures ul {
    max-height: 200px;
    margin: 6px 0 0;
    padding: 6px 6px 6px 22px;
    font: 12px/1.5 var(--mono);
  }
</style>
