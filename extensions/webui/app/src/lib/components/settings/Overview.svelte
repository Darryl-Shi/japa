<script lang="ts">
  import { onMount } from "svelte";
  import { getJson } from "$lib/api";
  import { API, type OverviewView } from "$lib/protocol";
  import { Loader } from "$lib/settings.svelte";
  import type { Section } from "./sections";

  let { go }: { go: (section: Section) => void } = $props();

  const overview = new Loader(() => getJson<OverviewView>(API.overview));
  onMount(() => void overview.load());

  function counts(c: OverviewView["counts"]): string {
    const parts = [`${c.on} on`, `${c.off} off`, `${c.notSetUp} not set up`];
    if (c.error > 0) parts.push(`${c.error} with errors`);
    return `Extensions: ${parts.join(", ")}.`;
  }
</script>

<div aria-busy={overview.loading}>
  {#if overview.error}
    <p class="set-reply" data-error>{overview.error}</p>
  {/if}
  {#if overview.data}
    {@const o = overview.data}
    <h3 class="set-group">CoS model</h3>
    <div class="set-card">
      <div class="set-row">
        {#if o.model}
          <span class="set-mono model">{o.model.provider} / {o.model.modelId}</span>
        {:else}
          <span class="set-muted">Not set.</span>
        {/if}
        <div class="set-actions">
          <button class="btn" type="button" onclick={() => go("models")}>Change models</button>
        </div>
      </div>
    </div>

    <h3 class="set-group">Errors</h3>
    {#if o.errors.length === 0}
      <p class="set-empty">No errors.</p>
    {:else}
      <ul class="set-card">
        {#each o.errors as err, i (i)}
          <li class="set-row">
            <span class="set-name">{err.name}</span>
            <p class="set-mono err">{err.error}</p>
          </li>
        {/each}
      </ul>
    {/if}

    <h3 class="set-group">Extensions</h3>
    <p class="count">{counts(o.counts)}</p>
    <button class="btn" type="button" onclick={() => go("extensions")}>Open Extensions</button>
  {:else if overview.loading}
    <p class="set-empty">Loading…</p>
  {/if}
</div>

<style>
  .model {
    font-size: var(--text-sm);
  }

  .err {
    margin: 0.15rem 0 0;
  }

  .count {
    margin: 0 0 0.6rem;
    font-size: var(--text-sm);
  }
</style>
