<script lang="ts">
  import { untrack } from 'svelte';
  import { facilityLabel, formatCount, itemName } from './format';
  import ItemIcon from './ItemIcon.svelte';
  import type { AppState } from './state.svelte';

  let { app }: { app: AppState } = $props();

  const MAX_RESULTS = 40;

  let query = $state('');
  const results = $derived(app.searchTargets(query));

  // The inputs keep their own text so typing "0." is not rewritten to "0" by the state round trip.
  const unitFactor = $derived(app.rateUnit === 'min' ? 60 : 1);
  const startQuantity = untrack(() => app.request.quantity); // read once: the initial text of the inputs
  let rateText = $state(startQuantity.kind === 'rate' ? formatCount(startQuantity.perSecond, 6) : '1');
  let countText = $state(startQuantity.kind === 'buildings' ? String(startQuantity.count) : '1');
  let lastRate = startQuantity.kind === 'rate' ? startQuantity.perSecond : 1;
  let lastCount = startQuantity.kind === 'buildings' ? startQuantity.count : 1;

  const kind = $derived(app.request.quantity.kind);

  const facilities = $derived.by(() => {
    const choices = app.targetFacilityChoices;
    const current = app.request.finalFacilityItemId;
    const building = app.index.building(current);
    // A facility the techs do not unlock stays selectable so the plan can say why it fails.
    const locked = building && !choices.some((b) => b.itemId === current) ? building : undefined;
    return { choices, locked };
  });

  function pick(itemId: number): void {
    app.setTarget(itemId);
    query = '';
  }

  function onSearchKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && results.length > 0) pick(results[0].id);
    else if (event.key === 'Escape') query = '';
  }

  function setKind(next: 'rate' | 'buildings'): void {
    if (next === kind) return;
    app.setQuantity(next === 'rate' ? { kind: 'rate', perSecond: lastRate } : { kind: 'buildings', count: lastCount });
  }

  function onRateInput(event: Event & { currentTarget: HTMLInputElement }): void {
    rateText = event.currentTarget.value;
    const value = Number(rateText);
    if (rateText.trim() === '' || !Number.isFinite(value) || value <= 0) return;
    lastRate = value / unitFactor;
    app.setQuantity({ kind: 'rate', perSecond: lastRate });
  }

  function onCountInput(event: Event & { currentTarget: HTMLInputElement }): void {
    countText = event.currentTarget.value;
    const value = Number(countText);
    if (countText.trim() === '' || !Number.isFinite(value) || value <= 0) return;
    lastCount = value;
    app.setQuantity({ kind: 'buildings', count: lastCount });
  }

  function setUnit(unit: 's' | 'min'): void {
    if (unit === app.rateUnit) return;
    app.setRateUnit(unit);
    rateText = formatCount(lastRate * (unit === 'min' ? 60 : 1), 6);
  }
</script>

<section class="card" aria-labelledby="target-title">
  <h2 id="target-title">Target</h2>
  <div class="stack">
    {#if app.hasTarget}
      <div class="current">
        <ItemIcon index={app.index} itemId={app.request.targetItemId} size={28} />
        <strong>{itemName(app.index, app.request.targetItemId)}</strong>
        <button type="button" class="clear" onclick={() => app.clearTarget()} title="Clear the target">Clear</button>
      </div>
    {/if}

    <div class="search">
      <input
        type="search"
        placeholder={app.hasTarget ? 'Change target: search items...' : 'Search items to build...'}
        aria-label="Search target items"
        autocomplete="off"
        bind:value={query}
        onkeydown={onSearchKey}
      />
      {#if query.trim() !== ''}
        <ul class="results scroll" aria-label="Matching items">
          {#each results.slice(0, MAX_RESULTS) as item (item.id)}
            <li>
              <button type="button" onclick={() => pick(item.id)}>
                <ItemIcon index={app.index} itemId={item.id} />
                <span>{item.name}</span>
              </button>
            </li>
          {:else}
            <li class="none muted">No item with a recipe matches "{query.trim()}".</li>
          {/each}
          {#if results.length > MAX_RESULTS}
            <li class="none muted">{results.length - MAX_RESULTS} more: keep typing to narrow.</li>
          {/if}
        </ul>
      {/if}
    </div>

    <div class="quantity">
      <div class="seg" role="group" aria-label="Quantity mode">
        <button type="button" aria-pressed={kind === 'rate'} onclick={() => setKind('rate')}>Rate</button>
        <button type="button" aria-pressed={kind === 'buildings'} onclick={() => setKind('buildings')}>Buildings</button>
      </div>
      {#if kind === 'rate'}
        <input
          class="num"
          type="number"
          min="0"
          step="any"
          aria-label="Target rate"
          value={rateText}
          oninput={onRateInput}
        />
        <div class="seg" role="group" aria-label="Rate unit">
          <button type="button" aria-pressed={app.rateUnit === 's'} onclick={() => setUnit('s')}>/s</button>
          <button type="button" aria-pressed={app.rateUnit === 'min'} onclick={() => setUnit('min')}>/min</button>
        </div>
      {:else}
        <input
          class="num"
          type="number"
          min="1"
          step="1"
          aria-label="Number of final buildings"
          value={countText}
          oninput={onCountInput}
        />
        <span class="muted">final buildings</span>
      {/if}
    </div>

    <label class="field">
      <span>Final facility</span>
      <select
        disabled={!app.hasTarget}
        value={app.request.finalFacilityItemId}
        onchange={(event) => app.setFinalFacility(Number(event.currentTarget.value))}
      >
        {#if !app.hasTarget}
          <option value={0}>Pick a target first</option>
        {/if}
        {#each facilities.choices as building (building.itemId)}
          <option value={building.itemId}>{facilityLabel(building)}</option>
        {/each}
        {#if facilities.locked}
          <option value={facilities.locked.itemId}>{facilityLabel(facilities.locked)} (not unlocked)</option>
        {/if}
      </select>
    </label>
  </div>
</section>

<style>
  .current {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--accent-soft);
  }

  .current strong {
    flex: 1;
    min-width: 0;
    font-size: 14px;
  }

  .clear {
    height: 22px;
    padding: 0 8px;
    font-size: 12px;
  }

  .search {
    position: relative;
  }

  .search input {
    width: 100%;
  }

  .results {
    max-height: 260px;
    margin: 4px 0 0;
    padding: 2px;
    list-style: none;
  }

  .results li button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 30px;
    border: 0;
    background: transparent;
    text-align: left;
  }

  .results li button:hover {
    background: var(--surface-3);
  }

  .none {
    padding: 6px 8px;
    font-size: 12px;
  }

  .quantity {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .quantity input {
    width: 84px;
    text-align: right;
  }

  .field select {
    width: 100%;
  }
</style>
