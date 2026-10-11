<script lang="ts">
  import type { Connection } from "$lib/live.svelte";

  let {
    connection,
    attached,
    busy,
    activeJobs,
    onjobs,
    onstatus,
  }: {
    connection: Connection;
    attached: boolean;
    busy: boolean;
    activeJobs: number;
    onjobs: (e: MouseEvent) => void;
    onstatus: (e: MouseEvent) => void;
  } = $props();

  const indicator = $derived(
    connection === "reconnecting"
      ? "reconnecting"
      : connection === "connecting" || !attached
        ? "connecting"
        : busy
          ? "busy"
          : "ready",
  );
  const label = $derived(
    { reconnecting: "reconnecting…", connecting: "connecting…", busy: "thinking…", ready: "ready" }[indicator],
  );
</script>

<header class="bar">
  <div class="inner">
    <span class="wordmark">japa</span>
    <p class="status" data-state={indicator} aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span class="label">{label}</span>
    </p>
    <nav class="actions" aria-label="Panels">
      <button class="btn ghost" type="button" onclick={onjobs} aria-haspopup="dialog">
        Jobs
        {#if activeJobs > 0}
          <span class="badge"><span class="visually-hidden">(</span>{activeJobs}<span class="visually-hidden"> active)</span></span>
        {/if}
      </button>
      <button class="btn ghost" type="button" onclick={onstatus} aria-haspopup="dialog">Status</button>
    </nav>
  </div>
</header>

<style>
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: saturate(1.4) blur(10px);
    -webkit-backdrop-filter: saturate(1.4) blur(10px);
    border-bottom: 1px solid var(--border);
  }

  .inner {
    max-width: calc(var(--column) + 2rem);
    margin: 0 auto;
    padding: 0.55rem 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .wordmark {
    font-size: var(--text-lg);
    font-weight: 650;
    letter-spacing: -0.03em;
  }

  .status {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .label {
    white-space: nowrap;
  }

  .dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: var(--gray-400);
  }

  [data-state="ready"] .dot {
    background: var(--text);
  }

  [data-state="busy"] .dot {
    background: var(--text);
    animation: pulse 1.2s ease-in-out infinite;
  }

  [data-state="reconnecting"] .dot,
  [data-state="connecting"] .dot {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--gray-500);
  }

  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }

  .actions {
    margin-left: auto;
    display: flex;
    gap: 0.25rem;
  }

  .badge {
    display: inline-grid;
    place-items: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.35rem;
    border-radius: var(--pill);
    background: var(--accent);
    color: var(--accent-text);
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    [data-state="busy"] .dot {
      animation: none;
    }
  }
</style>
