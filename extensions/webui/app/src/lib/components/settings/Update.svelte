<script lang="ts">
  import { onMount } from "svelte";
  import { getJson, postJson } from "$lib/api";
  import { confirm } from "$lib/confirm.svelte";
  import type { Connection } from "$lib/live.svelte";
  import { API, type UpdateCheckView, type UpdateView } from "$lib/protocol";
  import { age, Loader, Runner, when } from "$lib/settings.svelte";
  import ReplyNote from "./ReplyNote.svelte";

  let { connection }: { connection: Connection } = $props();

  const LISTED = 20;
  const short = (sha: string) => sha.slice(0, 7);
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

  const update = new Loader(() => getJson<UpdateView>(API.update));
  const runner = new Runner();
  let check = $state.raw<UpdateCheckView | undefined>();
  let started = $state(false);
  let checking = $state(false);
  onMount(() => void update.load());

  // japa restarts during an update: the live connection drops and comes back; then show the outcome.
  let wasDown = false;
  $effect(() => {
    if (connection !== "live") wasDown = true;
    else if (wasDown) {
      wasDown = false;
      started = false;
      check = undefined;
      void update.load();
    }
  });

  async function runCheck(): Promise<void> {
    check = undefined;
    checking = true;
    await runner.run("check", async () => {
      check = await postJson<UpdateCheckView>(API.updateCheck);
    });
    checking = false;
  }

  async function updateNow(c: UpdateCheckView): Promise<void> {
    const jobs = c.activeJobs > 0 ? ` ${plural(c.activeJobs, "job")} active.` : "";
    if (!(await confirm("Update japa now?", "Update now", `japa will restart.${jobs}`))) return;
    const ok = await runner.run("start", async () => {
      await postJson(API.updateStart, { to: c.target });
      return "Updating… japa will restart.";
    });
    if (ok) started = true;
    void update.load();
  }

  async function rollBack(to: string): Promise<void> {
    if (!(await confirm(`Roll back to ${short(to)}?`, "Roll back", "japa will restart."))) return;
    const ok = await runner.run("start", async () => {
      await postJson(API.updateRollback, { to });
      return "Rolling back… japa will restart.";
    });
    if (ok) started = true;
    void update.load();
  }
</script>

<div aria-busy={update.loading}>
  {#if update.error}
    <p class="set-reply" data-error>{update.error}</p>
  {/if}

  <h3 class="set-group">Last update</h3>
  <div class="set-card">
    <div class="set-row">
      {#if update.data}
        {@const last = update.data.last}
        {#if last === undefined}
          <p class="set-muted none">No update yet.</p>
        {:else}
          <div class="set-top">
            <span class="set-name">{last.rollback ? "Roll back" : "Update"}</span>
            <span class="set-pill" data-state={last.state === "failed" || last.state === "interrupted" ? "error" : last.state === "running" ? "on" : "off"}>
              {last.state}
            </span>
          </div>
          <p class="set-muted">
            {#if last.state === "running"}
              Running since {when(last.started)} ({age(last.started)}).
            {:else}
              Started {when(last.started)}{#if last.finished}, finished {when(last.finished)}{/if}.
            {/if}
          </p>
          <p class="set-mono">{short(last.from)}{#if last.to} → {short(last.to)}{/if}</p>
          {#if last.summary}<p class="summary">{last.summary}</p>{/if}
          {#if last.output}
            <details class="output">
              <summary>Output</summary>
              <pre class="set-mono">{last.output}</pre>
            </details>
          {/if}
          {#if last.state !== "running" && !last.rollback}
            <div class="set-actions">
              <button class="btn" type="button" disabled={runner.busy || started} onclick={() => rollBack(last.from)}>
                Roll back to {short(last.from)}
              </button>
            </div>
          {/if}
        {/if}
      {:else if update.loading}
        <p class="set-muted none">Loading…</p>
      {/if}
    </div>
  </div>

  <h3 class="set-group">Check</h3>
  <div class="set-actions top">
    <button class="btn" type="button" disabled={runner.busy} onclick={runCheck}>
      {checking ? "Checking…" : "Check for updates"}
    </button>
  </div>
  <ReplyNote reply={runner.for("check")} />
  {#if check}
    {#if check.commits.length === 0}
      <p class="set-reply">japa is up to date ({short(check.current)}).</p>
    {:else}
      {@const more = check.commits.length - LISTED}
      <div class="set-card commits-card">
        <div class="set-row">
          <p class="set-name">{plural(check.commits.length, "new commit")}: {short(check.current)} → {short(check.target)}</p>
          <ul class="commits set-mono">
            {#each check.commits.slice(0, LISTED) as commit, i (i)}
              <li>{commit}</li>
            {/each}
          </ul>
          {#if more > 0}<p class="set-muted">+{more} more</p>{/if}
          <p class="set-muted">japa will restart; {plural(check.activeJobs, "job")} active.</p>
          <div class="set-actions">
            <button class="btn primary" type="button" disabled={runner.busy || started} onclick={() => updateNow(check!)}>
              Update now
            </button>
          </div>
        </div>
      </div>
    {/if}
  {/if}
  <ReplyNote reply={runner.for("start")} />
</div>

<style>
  .none {
    margin: 0;
  }

  .summary {
    margin: 0.4rem 0 0;
    font-size: var(--text-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .output {
    margin-top: 0.5rem;
    font-size: var(--text-sm);
  }

  .output summary {
    cursor: pointer;
  }

  .output pre {
    margin: 0.4rem 0 0;
    max-height: 18rem;
    overflow: auto;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--code-bg);
  }

  .top {
    margin-top: 0;
  }

  .commits-card {
    margin-top: 0.75rem;
  }

  .commits {
    margin: 0.4rem 0;
    padding-left: 1.1rem;
  }

  .set-name {
    margin: 0;
  }
</style>
