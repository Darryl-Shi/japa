<script lang="ts">
  import { onMount } from "svelte";
  import { getJson, postJson } from "$lib/api";
  import { confirm } from "$lib/confirm.svelte";
  import { API, type ReplyView, type ScheduleView } from "$lib/protocol";
  import { Loader, Runner, when } from "$lib/settings.svelte";
  import ReplyNote from "./ReplyNote.svelte";

  const schedules = new Loader(() => getJson<ScheduleView[]>(API.schedules));
  const runner = new Runner();
  onMount(() => void schedules.load());

  async function act(s: ScheduleView, action: "pause" | "resume" | "remove"): Promise<void> {
    if (action === "remove" && !(await confirm("Remove this schedule?", "Remove", s.text))) return;
    await runner.run(
      action === "remove" ? "removed" : s.id,
      async () => (await postJson<ReplyView>(API.schedule, { id: s.id, action })).reply,
      () => schedules.load(),
    );
  }
</script>

<div aria-busy={schedules.loading}>
  {#if schedules.error}
    <p class="set-reply" data-error>{schedules.error}</p>
  {/if}
  <ReplyNote reply={runner.for("removed")} />
  {#if schedules.data}
    {#if schedules.data.length === 0}
      <p class="set-empty">No schedules.</p>
    {:else}
      <ul class="set-card">
        {#each schedules.data as s (s.id)}
          <li class="set-row">
            <div class="set-top">
              <span class="set-name">{s.label}</span>
              {#if s.paused}<span class="set-pill" data-state="paused">paused</span>{/if}
            </div>
            <p class="text">{s.text}</p>
            <p class="set-muted">
              {#if s.cron}Repeats: <span class="set-mono">{s.cron}</span>{:else if s.at}Once, {when(s.at)}{/if}
              {#if !s.paused} · next {when(s.next)}{/if}
            </p>
            <div class="set-actions">
              {#if s.paused}
                <button class="btn" type="button" disabled={runner.busy} onclick={() => act(s, "resume")}>Resume</button>
              {:else}
                <button class="btn" type="button" disabled={runner.busy} onclick={() => act(s, "pause")}>Pause</button>
              {/if}
              <button class="btn" type="button" disabled={runner.busy} onclick={() => act(s, "remove")}>Remove</button>
            </div>
            <ReplyNote reply={runner.for(s.id)} />
          </li>
        {/each}
      </ul>
    {/if}
  {:else if schedules.loading}
    <p class="set-empty">Loading…</p>
  {/if}
</div>

<style>
  .text {
    margin: 0.25rem 0 0;
    font-size: var(--text-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
