<script lang="ts">
  import { GameDataError, loadDefaultGameData } from './lib/data';
  import BlueprintPanel from './ui/BlueprintPanel.svelte';
  import InputsTree from './ui/InputsTree.svelte';
  import LayoutPreview from './ui/LayoutPreview.svelte';
  import OptionsPanel from './ui/OptionsPanel.svelte';
  import PlanTable from './ui/PlanTable.svelte';
  import SolvePanel from './ui/SolvePanel.svelte';
  import { createAppState } from './ui/state.svelte';
  import TargetPicker from './ui/TargetPicker.svelte';
  import TechPicker from './ui/TechPicker.svelte';
  import ValidationPanel from './ui/ValidationPanel.svelte';
  import './ui/theme.css';

  const title = 'DSP Factory Planner';

  const loading = loadDefaultGameData().then((data) => createAppState(data));

  function describe(error: unknown): { heading: string; detail: string } {
    if (error instanceof GameDataError) {
      return { heading: `Cannot use game data file ${error.fileName}`, detail: error.message };
    }
    return { heading: 'Cannot load game data', detail: error instanceof Error ? error.message : String(error) };
  }
</script>

{#await loading}
  <main class="status"><p class="muted">Loading game data...</p></main>
{:then app}
  <div class="shell">
    <header class="top">
      <h1>{title}</h1>
      {#if app.geometryBadge}
        <span
          class="badge"
          title="Building footprints in this data are estimates, so any layout or blueprint built from it is unverified in game."
        >{app.geometryBadge}</span>
      {/if}
      <span class="grow"></span>
      <span class="meta muted">
        Game {app.data.meta.gameVersion}, {app.data.meta.source === 'fixture' ? 'fixture data' : 'extracted data'}
      </span>
    </header>

    <main class="grid">
      <div class="config">
        <TargetPicker {app} />
        <TechPicker {app} />
        <InputsTree {app} />
        <OptionsPanel {app} />
      </div>
      <div class="results">
        <PlanTable {app} />
        <SolvePanel {app} />
        <LayoutPreview {app} />
        <ValidationPanel {app} />
        <BlueprintPanel {app} />
      </div>
    </main>
  </div>
{:catch error}
  {@const failure = describe(error)}
  <main class="status">
    <div class="callout error" role="alert">
      <strong>{failure.heading}</strong>
      <pre>{failure.detail}</pre>
    </div>
  </main>
{/await}

<style>
  .shell {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 16px 24px;
  }

  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 12px 0;
  }

  .top h1 {
    font-size: 18px;
    letter-spacing: -0.01em;
  }

  .grow {
    flex: 1;
  }

  .meta {
    font-size: 12px;
  }

  .grid {
    display: grid;
    grid-template-columns: 380px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }

  .config,
  .results {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  @media (max-width: 900px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .status {
    max-width: 720px;
    margin: 48px auto;
    padding: 0 16px;
  }

  .status pre {
    margin: 8px 0 0;
    white-space: pre-wrap;
    font: 12px/1.5 var(--mono);
  }
</style>
