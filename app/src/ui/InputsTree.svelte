<script lang="ts">
  import { formatRate, itemName } from './format';
  import ItemIcon from './ItemIcon.svelte';
  import type { AppState } from './state.svelte';

  let { app }: { app: AppState } = $props();

  const rows = $derived(app.tree);
  // What the plan imports per second, to show next to each supplied item.
  const importRates = $derived(
    new Map(app.plan?.ok ? app.plan.plan.imports.map((i) => [i.itemId, i.perSecond] as const) : []),
  );
</script>

<section class="card" aria-labelledby="inputs-title">
  <h2 id="inputs-title">Inputs</h2>
  {#if rows.length === 0}
    <p class="hint">Pick a target to see its recipe tree. Mark each item as supplied (imported) or made.</p>
  {:else}
    <ul class="tree">
      {#each rows as row, i (i)}
        {@const rate = importRates.get(row.itemId)}
        <li class:repeat={row.repeat} style:padding-left="{row.depth * 14 + 4}px">
          <ItemIcon index={app.index} itemId={row.itemId} size={20} />
          <span class="name" class:missing={row.leaf && !row.supplied && !row.root}>
            {itemName(app.index, row.itemId)}
          </span>
          {#if row.repeat}
            <span class="note muted">see above</span>
          {:else if row.supplied && rate !== undefined}
            <span class="note num muted">{formatRate(rate, app.rateUnit)}</span>
          {:else if row.leaf && !row.supplied && !row.root}
            <span class="note warn">no recipe</span>
          {/if}
          {#if row.root}
            <span class="tag">target</span>
          {:else}
            <div class="seg" role="group" aria-label="{itemName(app.index, row.itemId)}: supply or make">
              <button
                type="button"
                aria-pressed={row.supplied}
                onclick={() => app.setSupplied(row.itemId, true)}
              >Supply</button>
              <button
                type="button"
                aria-pressed={!row.supplied}
                disabled={row.leaf && row.supplied}
                title={row.leaf ? 'No unlocked recipe makes this item' : undefined}
                onclick={() => app.setSupplied(row.itemId, false)}
              >Make</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .tree {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    border-top: 1px solid var(--border);
  }

  li:first-child {
    border-top: 0;
  }

  li.repeat {
    opacity: 0.65;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name.missing {
    color: var(--danger);
  }

  .note {
    font-size: 11px;
    white-space: nowrap;
  }

  .note.warn {
    color: var(--danger);
  }

  .tag {
    padding: 1px 6px;
    border-radius: 9px;
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-size: 11px;
    font-weight: 600;
  }
</style>
