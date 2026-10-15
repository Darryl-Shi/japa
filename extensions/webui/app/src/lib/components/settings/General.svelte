<script lang="ts">
  import { onMount } from "svelte";
  import { getJson, postJson } from "$lib/api";
  import { confirm } from "$lib/confirm.svelte";
  import { API, type Json, type ReplyView } from "$lib/protocol";
  import { Loader, Runner } from "$lib/settings.svelte";
  import ReplyNote from "./ReplyNote.svelte";

  // The settings of Telegram's General screen. The typed text is sent as is: the kernel's validator converts "4" to 4
  // and answers `Not changed: …` for anything invalid.
  const FIELDS: { path: string; label: string }[] = [
    { path: "jobs.maxConcurrent", label: "Max concurrent jobs" },
    { path: "jobs.keepFinishedDays", label: "Keep finished jobs (days)" },
    { path: "memory.maxFacts", label: "Memory: max facts" },
    { path: "memory.maxTokens", label: "Memory: max tokens" },
    { path: "safety.toolErrorThreshold", label: "Tool errors before rollback" },
    { path: "safety.goodAfterMinutes", label: "Minutes until marked good" },
    { path: "context.toolResultTokens", label: "Tool result tokens" },
  ];

  const values = new Loader(() => getJson<{ [key: string]: Json }>(API.values));
  const runner = new Runner();
  onMount(() => void values.load());

  function valueAt(path: string): string {
    let v: Json | undefined = values.data;
    for (const part of path.split(".")) v = v && typeof v === "object" && !Array.isArray(v) ? v[part] : undefined;
    return v === undefined || v === null ? "" : String(v);
  }

  async function onsubmit(e: SubmitEvent, path: string): Promise<void> {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget as HTMLFormElement).get("value") ?? "").trim();
    await runner.run(path, async () => (await postJson<ReplyView>(API.set, { path, value: text })).reply, () =>
      values.load(),
    );
  }

  async function clearJobs(): Promise<void> {
    if (!(await confirm("Clear finished jobs?", "Clear", "Done, failed and cancelled jobs are removed from the list.")))
      return;
    await runner.run("clear", async () => (await postJson<ReplyView>(API.clearJobs)).reply);
  }
</script>

<div aria-busy={values.loading}>
  {#if values.error}
    <p class="set-reply" data-error>{values.error}</p>
  {/if}
  {#if values.data}
    <ul class="set-card">
      {#each FIELDS as f (f.path)}
        {@const id = `general-${f.path.replace(".", "-")}`}
        <li class="set-row">
          <label class="set-label" for={id}>{f.label}</label>
          <p class="set-muted set-mono">{f.path}</p>
          <form class="set-form" onsubmit={(e) => onsubmit(e, f.path)}>
            <input {id} name="value" class="field" inputmode="decimal" autocomplete="off" value={valueAt(f.path)} />
            <button class="btn" type="submit" disabled={runner.busy}>Save</button>
          </form>
          <ReplyNote reply={runner.for(f.path)} />
        </li>
      {/each}
    </ul>
  {:else if values.loading}
    <p class="set-empty">Loading…</p>
  {/if}

  <h3 class="set-group">Jobs</h3>
  <button class="btn" type="button" disabled={runner.busy} onclick={clearJobs}>Clear finished jobs</button>
  <ReplyNote reply={runner.for("clear")} />
</div>

<style>
  .set-form .field {
    flex: 0 1 10rem;
  }
</style>
