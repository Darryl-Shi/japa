<script lang="ts">
  import { onMount } from "svelte";
  import type { StatusView } from "$lib/protocol";
  import { fetchStatus } from "$lib/live.svelte";
  import Sheet from "./Sheet.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let status = $state<StatusView | undefined>();
  let error = $state<string | undefined>();
  let loading = $state(false);

  async function refresh(): Promise<void> {
    loading = true;
    const result = await fetchStatus();
    loading = false;
    if ("error" in result && typeof result.error === "string") {
      error = result.error;
    } else {
      error = undefined;
      status = result as StatusView;
    }
  }

  onMount(() => {
    void refresh();
  });
</script>

{#snippet refreshButton()}
  <button class="btn" type="button" onclick={refresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
{/snippet}

<Sheet title="Status" id="status" {onclose} actions={refreshButton}>
  <div aria-live="polite" aria-busy={loading}>
    {#if error}
      <p class="error">{error}</p>
    {/if}
    {#if status}
      <dl class="model">
        <dt>Model</dt>
        <dd>{status.model ? `${status.model.provider} / ${status.model.modelId}` : "not set"}</dd>
      </dl>

      <h3 class="group">Extensions</h3>
      <ul class="list">
        {#each status.extensions as ext (ext.name)}
          <li class="ext">
            <div class="top">
              <span class="name">{ext.name}</span>
              {#if ext.state && ext.state !== "on"}
                <span class="pill">{ext.state}</span>
              {/if}
            </div>
            {#if ext.summary}<p class="summary">{ext.summary}</p>{/if}
            {#if ext.status}<p class="line">{ext.status}</p>{/if}
          </li>
        {/each}
      </ul>

      {#if status.errors.length > 0}
        <h3 class="group">Errors</h3>
        <ul class="list">
          {#each status.errors as err, i (i)}
            <li class="ext err">
              <span class="name">{err.name}</span>
              <p class="line">{err.error}</p>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if loading}
      <p class="muted">Loading…</p>
    {/if}
  </div>
</Sheet>

<style>
  .error {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    font-size: var(--text-sm);
  }

  .muted {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .model {
    margin: 0 0 1rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-soft);
  }

  .model dt {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .model dd {
    margin: 0.1rem 0 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .group {
    margin: 1rem 0 0.5rem;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .ext {
    padding: 0.65rem 0.9rem;
  }

  .ext + .ext {
    border-top: 1px solid var(--border);
  }

  .top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .name {
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .pill {
    padding: 0 0.5rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--pill);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .summary,
  .line {
    margin: 0.1rem 0 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .summary {
    color: var(--text-muted);
  }

  .line {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: pre-wrap;
  }

  .err .line {
    color: var(--text);
  }
</style>
