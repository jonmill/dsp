<script lang="ts" module>
  // Icons are extracted from the game and not committed, so on a fresh checkout every icon would
  // 404. The first few icons asked for act as a probe: if none loads, every ItemIcon shows its
  // monogram without issuing requests of its own.
  const PROBE_LIMIT = 3;
  const probed: string[] = [];
  let failures = 0;
  let available = $state<'unknown' | 'yes' | 'no'>('unknown');

  function iconUrl(name: string): string {
    return `/icons/${encodeURIComponent(name)}.png`;
  }

  function probe(name: string): void {
    if (available !== 'unknown' || probed.length >= PROBE_LIMIT || probed.includes(name)) return;
    probed.push(name);
    const image = new Image();
    image.onload = () => {
      available = 'yes';
    };
    image.onerror = () => {
      failures++;
      if (failures >= PROBE_LIMIT) available = 'no';
    };
    image.src = iconUrl(name);
  }

  /** "Icons/ItemRecipe/processor" -> "processor" (the extractor names files by the last segment). */
  function iconName(iconPath: string): string {
    return iconPath.slice(iconPath.lastIndexOf('/') + 1);
  }

  function monogram(name: string): string {
    const words = name.split(/[\s-]+/).filter(Boolean);
    const letters = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2);
    return letters.toUpperCase();
  }
</script>

<script lang="ts">
  import type { GameDataIndex } from '../lib/data';
  import { itemName } from './format';

  let { index, itemId, size = 22 }: { index: GameDataIndex; itemId: number; size?: number } = $props();

  const name = $derived(itemName(index, itemId));
  const file = $derived.by(() => {
    try {
      return iconName(index.item(itemId).iconPath);
    } catch {
      return '';
    }
  });
  let brokenFile = $state('');

  $effect(() => {
    if (file !== '') probe(file);
  });

  const showImage = $derived(file !== '' && available === 'yes' && brokenFile !== file);
  const hue = $derived((itemId * 47) % 360);
</script>

{#if showImage}
  <img
    class="icon"
    src={iconUrl(file)}
    alt=""
    width={size}
    height={size}
    loading="lazy"
    onerror={() => (brokenFile = file)}
  />
{:else}
  <span
    class="icon mono"
    aria-hidden="true"
    style:width="{size}px"
    style:height="{size}px"
    style:font-size="{Math.round(size * 0.45)}px"
    style:background="hsl({hue} 42% 40%)"
  >{monogram(name)}</span>
{/if}

<style>
  .icon {
    flex: none;
    display: inline-block;
    border-radius: 4px;
    vertical-align: middle;
  }

  .mono {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 700;
    letter-spacing: -0.02em;
    user-select: none;
  }
</style>
