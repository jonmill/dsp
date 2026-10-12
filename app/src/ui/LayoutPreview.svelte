<script lang="ts">
  import { untrack } from 'svelte';
  import { on } from 'svelte/events';
  import type { ViolationEntity } from '../lib/validate';
  import { describeEntity, entityCentre, fitView, hitTest, layoutBounds, maxLevel, renderLayout, screenToGrid, zoomAt } from './preview';
  import type { View } from './preview';
  import { formatCount } from './format';
  import type { AppState } from './state.svelte';

  let { app }: { app: AppState } = $props();

  const layout = $derived(app.solve.layout);
  const top = $derived(layout ? maxLevel(layout) : 0);

  let canvas = $state<HTMLCanvasElement>();
  let width = $state(0);
  let height = $state(0);
  let view = $state.raw<View>({ scale: 10, origin: { x: 0, y: 0 } });
  /** -1 is "all levels". */
  let levelPick = $state(-1);
  const level = $derived(levelPick < 0 ? 'all' : Math.min(levelPick, top));
  /** The user has moved or zoomed the view, so a new layout must not take it away. */
  let touched = false;

  let hover = $state.raw<{ entity: ViolationEntity; x: number; y: number } | null>(null);
  let drag: { pointer: number; x: number; y: number } | null = null;
  let dragging = $state(false);

  const highlight = $derived(app.selectedViolation ? [app.selectedViolation] : []);

  function fit(): void {
    const l = app.solve.layout;
    const bounds = l && layoutBounds(l, app.index);
    if (!bounds || width === 0 || height === 0) return;
    view = fitView(bounds, width, height);
  }

  // Until the user takes the view, it follows the layout: the first layout, every better one, the canvas size.
  $effect(() => {
    if (!layout || width === 0 || height === 0) {
      touched = false;
      return;
    }
    if (!touched) untrack(fit);
  });

  // Picking a violation brings its entities to the middle of the view.
  $effect(() => {
    const violation = app.selectedViolation;
    const l = layout;
    if (!violation || !l) return;
    const points = violation.entities
      .map((entity) => entityCentre(l, app.index, entity))
      .filter((p): p is { x: number; y: number } => p !== null);
    if (points.length === 0) return;
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    untrack(() => {
      const scale = Math.max(view.scale, 8);
      view = { scale, origin: { x: width / 2 - cx * scale, y: height / 2 + cy * scale } };
      touched = true;
    });
  });

  // Draw. The canvas is sized in device pixels and drawn in CSS pixels, so lines stay sharp on a dense screen.
  $effect(() => {
    const target = canvas;
    const l = layout;
    if (!target || !l || width === 0 || height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelsW = Math.round(width * ratio);
    const pixelsH = Math.round(height * ratio);
    if (target.width !== pixelsW) target.width = pixelsW;
    if (target.height !== pixelsH) target.height = pixelsH;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    renderLayout(ctx, l, app.index, { level, scale: view.scale, origin: view.origin, highlight });
  });

  // The wheel zooms about the cursor. A listener of its own, because it has to cancel the page scroll.
  $effect(() => {
    const target = canvas;
    if (!target) return;
    return on(
      target,
      'wheel',
      (event) => {
        event.preventDefault();
        touched = true;
        view = zoomAt(view, event.offsetX, event.offsetY, Math.exp(-event.deltaY * 0.0015));
      },
      { passive: false },
    );
  });

  function zoom(factor: number): void {
    touched = true;
    view = zoomAt(view, width / 2, height / 2, factor);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    dragging = true;
    canvas?.setPointerCapture(event.pointerId);
    hover = null;
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag && drag.pointer === event.pointerId) {
      touched = true;
      view = { scale: view.scale, origin: { x: view.origin.x + event.clientX - drag.x, y: view.origin.y + event.clientY - drag.y } };
      drag = { ...drag, x: event.clientX, y: event.clientY };
      return;
    }
    const l = layout;
    if (!l) return;
    const at = screenToGrid(event.offsetX, event.offsetY, view);
    const entity = hitTest(l, app.index, at.x, at.y, { level, tolerance: 5 / view.scale });
    hover = entity ? { entity, x: event.offsetX, y: event.offsetY } : null;
  }

  function onPointerUp(event: PointerEvent): void {
    if (drag?.pointer !== event.pointerId) return;
    drag = null;
    dragging = false;
  }

  const tip = $derived(hover && layout ? describeEntity(layout, app.index, hover.entity) : '');
  const counts = $derived(
    layout ? `${layout.buildings.length} buildings, ${layout.belts.length} belts, ${layout.sorters.length} sorters` : '',
  );
</script>

<section class="card" aria-labelledby="preview-title">
  <h2 id="preview-title">
    <span class="grow">Layout preview</span>
    {#if layout && app.solve.footprint !== null}
      <span class="stat">{formatCount(app.solve.footprint)} tiles</span>
    {/if}
  </h2>

  {#if !layout}
    <p class="hint">
      {app.solve.status === 'running' ? 'Waiting for the first valid layout...' : 'Solve a plan to see its layout.'}
    </p>
  {:else}
    <div class="toolbar">
      <button type="button" onclick={() => { touched = false; fit(); }}>Fit to view</button>
      <span class="seg" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" onclick={() => zoom(1 / 1.4)}>-</button>
        <button type="button" aria-label="Zoom in" onclick={() => zoom(1.4)}>+</button>
      </span>
      <label class="level">
        <span class="muted">Level</span>
        <input
          type="range"
          min="-1"
          max={top}
          step="1"
          value={levelPick < 0 ? -1 : Math.min(levelPick, top)}
          aria-label="Height level"
          aria-valuetext={level === 'all' ? 'all levels' : `level ${level}`}
          oninput={(event) => (levelPick = Number(event.currentTarget.value))}
        />
        <output class="num">{level === 'all' ? 'all' : level}</output>
      </label>
      <span class="grow"></span>
      <span class="muted counts">{counts}</span>
    </div>

    <div class="stage" bind:clientWidth={width} bind:clientHeight={height}>
      <canvas
        bind:this={canvas}
        class:dragging
        aria-label="Plan view of the layout: {counts}. North is up."
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onpointerleave={() => (hover = null)}
      >Plan view of the layout: {counts}.</canvas>
      {#if hover && tip}
        <div
          class="tip"
          role="tooltip"
          style:left={hover.x > width / 2 ? undefined : `${hover.x + 14}px`}
          style:right={hover.x > width / 2 ? `${width - hover.x + 14}px` : undefined}
          style:top={hover.y > height / 2 ? undefined : `${hover.y + 14}px`}
          style:bottom={hover.y > height / 2 ? `${height - hover.y + 14}px` : undefined}
        >{tip}</div>
      {/if}
    </div>
    <p class="hint legend">
      Drag to pan, wheel to zoom, north is up. Boxes are buildings, lines are belts coloured by item, arrows are sorters,
      the pale circles are power cover. A violation you pick in the report is drawn in red.
    </p>
  {/if}
</section>

<style>
  .grow {
    flex: 1;
    min-width: 0;
  }

  .stat {
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    color: var(--text-dim);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-bottom: 8px;
  }

  .seg > button {
    height: 28px;
    padding: 0 12px;
  }

  .level {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .level input {
    width: 140px;
    margin: 0;
  }

  .level output {
    min-width: 2.5em;
  }

  .counts {
    font-size: 11px;
  }

  .stage {
    position: relative;
    height: min(560px, 70vh);
    min-height: 280px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    overflow: hidden;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: grab;
    touch-action: none;
  }

  canvas.dragging {
    cursor: grabbing;
  }

  .tip {
    position: absolute;
    z-index: 1;
    max-width: 260px;
    padding: 6px 8px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 2px 8px rgb(0 0 0 / 25%);
    font-size: 12px;
    white-space: pre-line;
    pointer-events: none;
  }

  .legend {
    margin-top: 8px;
  }
</style>
