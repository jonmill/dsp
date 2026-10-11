<script lang="ts">
  import type { Recipe } from '../lib/data';
  import { buildingName, facilityLabel, formatPower, itemName } from './format';
  import type { AppState } from './state.svelte';

  let { app }: { app: AppState } = $props();

  const TIERS = [
    { tier: 0, label: 'None' },
    { tier: 1, label: 'Mk.I' },
    { tier: 2, label: 'Mk.II' },
    { tier: 3, label: 'Mk.III' },
  ] as const;

  const ticksPerSecond = $derived(app.data.constants.ticksPerSecond);
  const range = $derived(app.stationChargeRange);
  const charge = $derived(app.request.stationChargePerTick ?? range.default);
  const chargeCustom = $derived(app.request.stationChargePerTick !== undefined);

  // Items shown in the tree that have more than one unlocked recipe (once each; repeats are the same item).
  const alternates = $derived(app.tree.filter((r) => !r.repeat && !r.supplied && r.producers.length > 1));
  // The recipes the tree expands, once each (one recipe can make two tree items), except the
  // target's: its facility is the "Final facility" select.
  const stages = $derived.by(() => {
    const recipes: Recipe[] = [];
    for (const row of app.tree) {
      if (!row.root && row.recipe && !recipes.includes(row.recipe)) recipes.push(row.recipe);
    }
    return recipes;
  });

  // The facility the planner picked when "Auto" is selected, from the current plan.
  const planned = $derived(
    new Map(app.plan?.ok ? app.plan.plan.stages.map((s) => [s.recipeId, s.buildingItemId] as const) : []),
  );

  function numberOrNull(text: string): number | null {
    const value = Number(text);
    return text.trim() !== '' && Number.isFinite(value) ? value : null;
  }

  function pickFacility(recipeId: number, value: string): void {
    app.setFacilityOverride(recipeId, value === '' ? undefined : Number(value));
  }

  function pickRecipe(itemId: number, value: string): void {
    app.setRecipeOverride(itemId, value === '' ? undefined : Number(value));
  }
</script>

<section class="card" aria-labelledby="options-title">
  <h2 id="options-title">Options</h2>
  <div class="stack">
    <fieldset>
      <legend>Proliferator</legend>
      <div class="row">
        <select
          aria-label="Proliferator tier"
          value={app.request.proliferator.tier}
          onchange={(event) =>
            app.setProliferator({
              tier: Number(event.currentTarget.value) as 0 | 1 | 2 | 3,
              mode: app.request.proliferator.mode,
            })}
        >
          {#each TIERS as { tier, label } (tier)}
            <option value={tier}>{label}</option>
          {/each}
        </select>
        <div class="seg" role="group" aria-label="Proliferator mode">
          <button
            type="button"
            disabled={app.request.proliferator.tier === 0}
            aria-pressed={app.request.proliferator.mode === 'extra'}
            onclick={() => app.setProliferator({ tier: app.request.proliferator.tier, mode: 'extra' })}
          >Extra products</button>
          <button
            type="button"
            disabled={app.request.proliferator.tier === 0}
            aria-pressed={app.request.proliferator.mode === 'speed'}
            onclick={() => app.setProliferator({ tier: app.request.proliferator.tier, mode: 'speed' })}
          >Speed-up</button>
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Logistics stations</legend>
      <div class="stack">
        <div class="row">
          <select
            aria-label="Station kind"
            value={app.request.stationKind}
            onchange={(event) => app.setStationKind(event.currentTarget.value === 'interstellar' ? 'interstellar' : 'planetary')}
          >
            <option value="planetary">Planetary</option>
            <option value="interstellar">Interstellar</option>
          </select>
          <span class="muted">charge</span>
          <strong class="num">{formatPower(charge * ticksPerSecond)}</strong>
          <button type="button" disabled={!chargeCustom} onclick={() => app.setStationCharge(undefined)}>Default</button>
        </div>
        <input
          type="range"
          aria-label="Station charge"
          min={range.min}
          max={range.max}
          step={range.step}
          value={charge}
          oninput={(event) => app.setStationCharge(numberOrNull(event.currentTarget.value) ?? undefined)}
        />
        <div class="scale num muted">
          <span>{formatPower(range.min * ticksPerSecond)}</span>
          <span>{formatPower(range.max * ticksPerSecond)}</span>
        </div>
      </div>
    </fieldset>

    {#if alternates.length > 0}
      <fieldset>
        <legend>Alternate recipes</legend>
        <div class="stack">
          {#each alternates as row (row.itemId)}
            <label class="pick">
              <span>{itemName(app.index, row.itemId)}</span>
              <select
                value={app.request.recipeOverrides[row.itemId] ?? ''}
                onchange={(event) => pickRecipe(row.itemId, event.currentTarget.value)}
              >
                <option value="">Auto{row.recipe ? ` (${row.recipe.name})` : ''}</option>
                {#each row.producers as recipe (recipe.id)}
                  <option value={recipe.id}>{recipe.name}</option>
                {/each}
              </select>
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}

    {#if stages.length > 0}
      <fieldset>
        <legend>Facilities</legend>
        <div class="stack">
          {#each stages as recipe (recipe.id)}
            {@const auto = planned.get(recipe.id)}
            <label class="pick">
              <span>{recipe.name}</span>
              <select
                value={app.request.facilityOverrides[recipe.id] ?? ''}
                onchange={(event) => pickFacility(recipe.id, event.currentTarget.value)}
              >
                <option value="">Auto{auto !== undefined ? ` (${buildingName(app.index, auto)})` : ''}</option>
                {#each app.facilityChoices(recipe.id) as building (building.itemId)}
                  <option value={building.itemId}>{facilityLabel(building)}</option>
                {/each}
              </select>
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}

    <fieldset>
      <legend>Layout solver</legend>
      <label class="row">
        <span>Time budget</span>
        <input
          class="num"
          type="number"
          min="1"
          step="1"
          value={app.solverBudgetMinutes}
          onchange={(event) => {
            const minutes = numberOrNull(event.currentTarget.value);
            if (minutes === null || minutes <= 0) event.currentTarget.value = String(app.solverBudgetMinutes);
            else app.setSolverBudgetMinutes(minutes);
          }}
        />
        <span class="muted">minutes</span>
      </label>
      <p class="hint">Used when the layout solver arrives; it does not change the plan.</p>
    </fieldset>
  </div>
</section>

<style>
  fieldset {
    margin: 0;
    padding: 8px 10px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  legend {
    padding: 0 4px;
    font-size: 11px;
    color: var(--text-dim);
  }

  input[type='range'] {
    width: 100%;
    margin: 0;
  }

  .scale {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
  }

  .pick {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
    align-items: center;
    gap: 8px;
  }

  .pick span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pick select {
    width: 100%;
  }

  input[type='number'] {
    width: 72px;
    text-align: right;
  }
</style>
