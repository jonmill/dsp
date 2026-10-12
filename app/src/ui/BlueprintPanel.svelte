<script lang="ts">
  import type { AppState } from './state.svelte';

  let { app }: { app: AppState } = $props();

  const blueprint = $derived(app.blueprint);

  let area = $state<HTMLTextAreaElement>();
  let notice = $state('');

  /** Selects the text, so Ctrl/Cmd+C works when the clipboard API does not. */
  function selectAll(): void {
    area?.focus();
    area?.select();
  }

  async function copy(): Promise<void> {
    if (!blueprint?.text) return;
    try {
      await navigator.clipboard.writeText(blueprint.text);
      notice = 'Copied to the clipboard.';
      return;
    } catch {
      // No clipboard API here (an insecure page, or permission denied): fall back to selecting and copying.
    }
    selectAll();
    let copied: boolean;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    notice = copied ? 'Copied to the clipboard.' : 'Could not copy. The text is selected: press Ctrl+C (Cmd+C on a Mac).';
  }

  function download(): void {
    if (!blueprint?.text) return;
    const url = URL.createObjectURL(new Blob([blueprint.text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = blueprint.fileName;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    notice = `Saved as ${blueprint.fileName}.`;
  }
</script>

<section class="card" aria-labelledby="blueprint-title">
  <h2 id="blueprint-title">Blueprint</h2>

  {#if blueprint?.approximate}
    <div class="callout warn" role="note">
      <strong>Geometry: approximate - unverified in game.</strong>
      This layout was built on estimated building footprints, and the blueprint's yaw and axis conventions have not
      been checked in game. Expect pieces that overlap or do not connect when you paste it. The blueprint description
      carries the same flag.
    </div>
  {/if}

  {#if app.solve.stale && blueprint}
    <div class="callout warn" role="status">
      This blueprint is for the earlier plan. Solve again to build one for the current plan.
    </div>
  {/if}

  {#if !blueprint}
    <p class="hint">
      {app.solve.status === 'idle' ? 'Solve a plan to get its blueprint.' : 'The blueprint appears once there is a valid layout.'}
    </p>
  {:else if blueprint.error}
    <div class="callout error" role="alert">{blueprint.error}</div>
  {:else}
    <textarea
      bind:this={area}
      readonly
      rows="6"
      spellcheck="false"
      aria-label="Blueprint string"
      value={blueprint.text}
      onfocus={() => area?.select()}
    ></textarea>
    <div class="actions">
      <button type="button" class="primary" onclick={copy}>Copy</button>
      <button type="button" onclick={download}>Download .txt</button>
      <span class="hint num">{blueprint.fileName}, {blueprint.text.length} characters</span>
    </div>
    <p class="hint" role="status">{notice}</p>
  {/if}

  <p class="note">Paste within the equatorial band (±28° latitude); pasting near the poles may fail</p>
</section>

<style>
  .callout {
    margin-bottom: 10px;
  }

  textarea {
    display: block;
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font: 11px/1.4 var(--mono);
    resize: vertical;
    word-break: break-all;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }

  .actions .hint {
    margin-left: auto;
  }

  p.hint:empty {
    display: none;
  }

  .note {
    margin: 10px 0 0;
    padding-top: 8px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-dim);
  }
</style>
