<script lang="ts">
  // A background job's report in the transcript: a card with the job's title and status, its body as markdown
  // (rendered and sanitised like assistant text), clipped past about 12 lines with a Show more / Show less toggle.
  import { renderMarkdown } from "$lib/markdown";
  import { reducedMotion } from "$lib/motion";
  import StatusPill from "./StatusPill.svelte";

  let { title, status, text }: { title: string; status: string; text: string } = $props();

  const LINES = 12;
  // Only clip when it hides more than this many lines: clipping off a line or two isn't worth a toggle.
  const SLACK = 1;

  const uid = $props.id();
  const bodyId = `report-${uid}`;
  const html = $derived(renderMarkdown(text));

  let card: HTMLElement | undefined = $state();
  let content: HTMLElement | undefined = $state();
  let overflows = $state(false);
  let expanded = $state(false);
  const clipped = $derived(overflows && !expanded);

  /** Re-measures whenever the content's size changes (new text, a narrower window, fonts loading). */
  $effect(() => {
    const node = content;
    if (!node) return;
    const measure = () => {
      const style = getComputedStyle(node);
      let line = parseFloat(style.lineHeight);
      if (!Number.isFinite(line)) line = parseFloat(style.fontSize) * 1.6;
      overflows = node.scrollHeight > line * (LINES + SLACK);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  });

  function toggle() {
    expanded = !expanded;
    if (!expanded && card) {
      // Collapsing a long report can leave its top far above the viewport: bring the card back into view.
      const top = card.getBoundingClientRect().top;
      if (top < 0) card.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }

  /** Tabbing to a link hidden under the clip opens the report, so the focused link is visible. */
  function onfocusin(e: FocusEvent) {
    if (!clipped) return;
    const target = e.target as Element | null;
    const body = target?.closest(".body");
    if (!target || !body) return;
    if (target.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom) expanded = true;
  }
</script>

<article class="report" aria-label="Job report: {title}" bind:this={card} {onfocusin}>
  <header class="head">
    <span class="kicker">Job report</span>
    <span class="title">{title}</span>
    <StatusPill {status} />
  </header>
  {#if text.trim() !== ""}
    <div class="body" class:clipped id={bodyId}>
      <div class="markdown" bind:this={content}>{@html html}</div>
    </div>
    {#if overflows}
      <button class="more" type="button" aria-expanded={expanded} aria-controls={bodyId} onclick={toggle}>
        {expanded ? "Show less" : "Show more"}
      </button>
    {/if}
  {/if}
</article>

<style>
  .report {
    max-width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.75rem 1rem 0.85rem;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.6rem;
    margin-bottom: 0.55rem;
  }

  .kicker {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .title {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .body {
    position: relative;
    line-height: 1.6;
  }

  .body.clipped {
    max-height: calc(12 * 1.6em);
    overflow: hidden;
  }

  .body.clipped::after {
    content: "";
    position: absolute;
    inset: auto 0 0;
    height: 3.2em;
    background: linear-gradient(to bottom, transparent, var(--surface));
    pointer-events: none;
  }

  .more {
    margin-top: 0.5rem;
    padding: 0.15rem 0.7rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--pill);
    background: transparent;
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 1.6;
  }

  .more:hover {
    background: var(--gray-50);
  }
</style>
