<script lang="ts">
  import { allTechs } from '../lib/data';
  import { techLabel } from './format';
  import type { AppState } from './state.svelte';
  import { UNLOCK_ALL_PROFILE } from './state.svelte';

  let { app }: { app: AppState } = $props();

  let query = $state('');
  let profileDraft = $state('');

  // Published, non-obsolete techs in tech-id order (roughly the order the tree is researched).
  const techs = $derived.by(() => {
    const known = allTechs(app.data);
    return app.data.techs.filter((t) => known.has(t.id)).sort((a, b) => a.id - b.id);
  });
  const visible = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return techs;
    return techs.filter((t) => techLabel(t).toLowerCase().includes(needle) || String(t.id).includes(needle));
  });
  const unlocked = $derived(app.request.unlockedTechs);
  const savedNames = $derived(Object.keys(app.profiles).sort((a, b) => a.localeCompare(b)));
  const canDelete = $derived(Object.hasOwn(app.profiles, app.techProfileName));

  function save(): void {
    if (app.saveProfile(profileDraft)) profileDraft = '';
  }
</script>

<section class="card" aria-labelledby="tech-title">
  <h2 id="tech-title">
    <span class="grow">Technology</span>
    <span class="num muted">{unlocked.size} / {techs.length}</span>
  </h2>
  <div class="stack">
    <div class="row">
      <label class="field grow">
        <span>Profile</span>
        <select value={app.techProfileName} onchange={(event) => app.selectProfile(event.currentTarget.value)}>
          <option value={UNLOCK_ALL_PROFILE}>{UNLOCK_ALL_PROFILE}</option>
          {#each savedNames as name (name)}
            <option value={name}>{name}</option>
          {/each}
          {#if app.techProfileName === ''}
            <option value="" disabled>Custom selection</option>
          {/if}
        </select>
      </label>
      <button
        type="button"
        class="del"
        disabled={!canDelete}
        onclick={() => app.deleteProfile(app.techProfileName)}
        title="Delete the selected saved profile"
      >Delete</button>
    </div>

    <form
      class="row"
      onsubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <input
        type="text"
        class="grow"
        placeholder="Save selection as..."
        aria-label="Profile name"
        bind:value={profileDraft}
      />
      <button type="submit" disabled={profileDraft.trim() === ''}>Save</button>
    </form>

    <div class="row">
      <button type="button" onclick={() => app.unlockAll()}>Unlock all</button>
      <button type="button" onclick={() => app.setUnlockedTechs([])} disabled={unlocked.size === 0}>Clear</button>
      <select
        class="grow"
        aria-label="Unlock up to"
        value=""
        onchange={(event) => {
          const id = Number(event.currentTarget.value);
          event.currentTarget.value = '';
          if (id > 0) app.unlockUpTo(id);
        }}
      >
        <option value="">Unlock up to...</option>
        {#each techs as tech (tech.id)}
          <option value={tech.id}>{techLabel(tech)}</option>
        {/each}
      </select>
    </div>

    <input
      type="search"
      placeholder="Search technologies..."
      aria-label="Search technologies"
      autocomplete="off"
      bind:value={query}
    />
    <ul class="list scroll" aria-label="Technologies">
      {#each visible as tech (tech.id)}
        <li>
          <label>
            <input type="checkbox" checked={unlocked.has(tech.id)} onchange={() => app.toggleTech(tech.id)} />
            <span>{techLabel(tech)}</span>
          </label>
        </li>
      {:else}
        <li class="none muted">No technology matches "{query.trim()}".</li>
      {/each}
    </ul>
  </div>
</section>

<style>
  .grow {
    flex: 1;
    min-width: 0;
  }

  .field select {
    width: 100%;
  }

  .del {
    align-self: flex-end;
  }

  .list {
    max-height: 240px;
    margin: 0;
    padding: 2px;
    list-style: none;
  }

  .list label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
  }

  .list label:hover {
    background: var(--surface-3);
  }

  .none {
    padding: 6px 8px;
  }
</style>
