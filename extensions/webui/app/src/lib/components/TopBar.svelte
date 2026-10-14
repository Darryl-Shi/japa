<script lang="ts">
  import type { Connection } from "$lib/live.svelte";

  let {
    connection,
    attached,
    busy,
    activeJobs,
    desktopOpen,
    settingsOpen,
    wide,
    onjobs,
    ondesktop,
    onsettings,
  }: {
    connection: Connection;
    attached: boolean;
    busy: boolean;
    activeJobs: number;
    desktopOpen: boolean;
    settingsOpen: boolean;
    /** Full width (a docked panel or the Settings page is open), not the chat column. */
    wide: boolean;
    onjobs: (e: MouseEvent) => void;
    ondesktop: (e: MouseEvent) => void;
    onsettings: (e: MouseEvent) => void;
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
  <div class="inner" class:wide>
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
      <button class="btn ghost" type="button" onclick={ondesktop} aria-expanded={desktopOpen}>Desktop</button>
      <button class="btn ghost icon" type="button" onclick={onsettings} aria-label="Settings" aria-expanded={settingsOpen}>
        <svg class="gear" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
          />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
        </svg>
      </button>
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
    min-height: calc(var(--bar-height) - 1px);
    padding: 0.55rem 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .inner.wide {
    max-width: none;
  }

  .gear {
    display: block;
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
