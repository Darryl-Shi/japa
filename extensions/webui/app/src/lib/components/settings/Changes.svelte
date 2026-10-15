<script lang="ts">
  import { onMount } from "svelte";
  import { getJson, postJson } from "$lib/api";
  import { confirm } from "$lib/confirm.svelte";
  import { API, type ChangeView, type ReplyView } from "$lib/protocol";
  import { age, Loader, Runner, when } from "$lib/settings.svelte";
  import ReplyNote from "./ReplyNote.svelte";

  const changes = new Loader(() => getJson<ChangeView[]>(API.changes));
  const runner = new Runner();
  onMount(() => void changes.load());

  let expanded = $state<Record<string, boolean>>({});

  async function undo(c: ChangeView): Promise<void> {
    if (!(await confirm(`Undo “${c.title}”?`, "Undo"))) return;
    await runner.run("undo", async () => (await postJson<ReplyView>(API.undo, { id: c.id })).reply, () =>
      changes.load(),
    );
  }
</script>

<div aria-busy={changes.loading}>
  {#if changes.error}
    <p class="set-reply" data-error>{changes.error}</p>
  {/if}
  <ReplyNote reply={runner.for("undo")} />
  {#if changes.data}
    {#if changes.data.length === 0}
      <p class="set-empty">No changes yet.</p>
    {:else}
      <ul class="set-card">
        {#each changes.data.slice(0, 10) as c (c.id)}
          {@const open = expanded[c.id] === true}
          <li class="set-row">
            <div class="set-top">
              <span class="set-name">{c.title}</span>
              <span class="set-muted age" title={when(c.at)}>{age(c.at)}</span>
            </div>
            <div class="set-actions">
              {#if c.detail}
                <button
                  class="btn ghost"
                  type="button"
                  aria-expanded={open}
                  aria-controls="change-{c.id}"
                  onclick={() => (expanded[c.id] = !open)}
                >
                  {open ? "Hide details" : "Details"}
                </button>
              {/if}
              <button class="btn" type="button" disabled={runner.busy} onclick={() => undo(c)}>Undo</button>
            </div>
            {#if open}
              <p class="set-mono detail" id="change-{c.id}">{c.detail}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if changes.loading}
    <p class="set-empty">Loading…</p>
  {/if}
</div>

<style>
  .age {
    margin: 0 0 0 auto;
    font-size: var(--text-xs);
  }

  .detail {
    margin: 0.5rem 0 0;
  }
</style>
