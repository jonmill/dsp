<script lang="ts">
  import { CONVENTIONS_VERIFIED } from '../lib/blueprint';
  import type { AppState } from './state.svelte';

  /** How long a download's blob URL lives. */
  const REVOKE_AFTER_MS = 10_000;

  let { app }: { app: AppState } = $props();

  const blueprint = $derived(app.blueprint);

  let area = $state<HTMLTextAreaElement>();
  /** What the last copy or download said, and which blueprint string it was about. */
  let last = $state.raw({ text: '', about: '' });
  /** A notice about an older string is not shown: a new layout has a new blueprint. */
  const notice = $derived(blueprint && last.about === blueprint.text ? last.text : '');

  function say(text: string, about: string): void {
    last = { text, about };
  }

  /** Selects the text, so Ctrl/Cmd+C works when the clipboard API does not. */
  function selectAll(): void {
    area?.focus();
    area?.select();
  }

  async function copy(): Promise<void> {
    const text = blueprint?.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      say('Copied to the clipboard.', text);
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
    say(copied ? 'Copied to the clipboard.' : 'Could not copy. The text is selected: press Ctrl+C (Cmd+C on a Mac).', text);
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
    // Not at once: some browsers start the save after the click has returned.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
    say(`Saved as ${blueprint.fileName}.`, blueprint.text);
  }
</script>

<section class="card" aria-labelledby="blueprint-title">
  <h2 id="blueprint-title">Blueprint</h2>

  {#if blueprint?.approximate}
    <div class="callout warn" role="note">
      <strong>Geometry: approximate - unverified in game.</strong>
      This layout was built on estimated building footprints. Expect pieces that overlap or do not connect when you
      paste it. The blueprint description carries the same flag.
    </div>
  {/if}

  <!-- Extracting the geometry does not check the yaw and axis conventions: only a paste in game does. -->
  {#if blueprint && !CONVENTIONS_VERIFIED}
    <div class="callout warn" role="note">
      <strong>Conventions: not yet verified in game.</strong>
      The blueprint's yaw and axis conventions have not been checked by pasting one in game, with the real building
      geometry or not (runbook item 1). If a pasted block comes out rotated or mirrored, that is the reason. The
      blueprint description carries the same flag.
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
