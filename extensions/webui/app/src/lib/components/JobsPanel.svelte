<script lang="ts">
  import type { JobStatus, JobView } from "$lib/protocol";
  import Sheet from "./Sheet.svelte";
  import StatusPill from "./StatusPill.svelte";

  let { jobs, onclose }: { jobs: JobView[]; onclose: () => void } = $props();

  const ACTIVE: ReadonlySet<JobStatus> = new Set(["queued", "running", "needs_input"]);
  const ORDER: Record<JobStatus, number> = { needs_input: 0, running: 1, queued: 2, done: 3, failed: 3, cancelled: 3 };
  const RECENT = 20;

  const active = $derived(
    jobs.filter((j) => ACTIVE.has(j.status)).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.createdAt - b.createdAt),
  );
  const finished = $derived(
    jobs
      .filter((j) => !ACTIVE.has(j.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT),
  );

  let expanded = $state<Record<string, boolean>>({});

  /** The one-line summary under the title: progress while running, the question, or the result. */
  function summary(job: JobView): string | undefined {
    if (job.status === "running" || job.status === "queued") return job.progress;
    return job.result ?? job.progress;
  }

  const when = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
</script>

{#snippet row(job: JobView)}
  {@const open = expanded[job.id] === true}
  {@const line = summary(job)}
  <li class="job" data-status={job.status}>
    <button
      class="summary"
      type="button"
      aria-expanded={open}
      aria-controls="job-{job.id}"
      onclick={() => (expanded[job.id] = !open)}
    >
      <span class="top">
        <span class="id">{job.id}</span>
        <span class="status"><StatusPill status={job.status} /></span>
      </span>
      <span class="title">{job.title}</span>
      {#if line}
        <span class="line">{line}</span>
      {/if}
    </button>
    {#if open}
      <div class="detail" id="job-{job.id}">
        <h4>Brief</h4>
        <p class="pre">{job.brief}</p>
        {#if job.progress && job.progress !== job.result}
          <h4>Progress</h4>
          <p class="pre">{job.progress}</p>
        {/if}
        {#if job.result}
          <h4>{job.status === "needs_input" ? "Question" : job.status === "failed" ? "Reason" : "Result"}</h4>
          <p class="pre">{job.result}</p>
        {/if}
        <p class="times">Started {when(job.createdAt)} · updated {when(job.updatedAt)}</p>
      </div>
    {/if}
  </li>
{/snippet}

<Sheet title="Jobs" id="jobs" {onclose}>
  {#if jobs.length === 0}
    <p class="empty">No jobs yet. Background work the CoS starts shows up here.</p>
  {:else}
    <section aria-labelledby="jobs-active">
      <h3 id="jobs-active" class="group">Active</h3>
      {#if active.length === 0}
        <p class="none">Nothing running.</p>
      {:else}
        <ul class="list">
          {#each active as job (job.id)}{@render row(job)}{/each}
        </ul>
      {/if}
    </section>
    {#if finished.length > 0}
      <section aria-labelledby="jobs-recent">
        <h3 id="jobs-recent" class="group">Recent</h3>
        <ul class="list">
          {#each finished as job (job.id)}{@render row(job)}{/each}
        </ul>
      </section>
    {/if}
  {/if}
</Sheet>

<style>
  .empty,
  .none {
    margin: 0.25rem 0 1rem;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .group {
    margin: 0.75rem 0 0.5rem;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .list {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .job {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .summary {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.7rem 0.9rem;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    text-align: left;
  }

  .summary:hover {
    background: var(--gray-50);
  }

  .top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .id {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title {
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .line {
    font-size: var(--text-sm);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    margin-left: auto;
    flex: none;
    display: flex;
  }

  .job[data-status="needs_input"] {
    border-color: var(--text);
  }

  .detail {
    padding: 0 0.9rem 0.8rem;
    border-top: 1px solid var(--border);
    font-size: var(--text-sm);
  }

  .detail h4 {
    margin: 0.7rem 0 0.15rem;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .times {
    margin: 0.7rem 0 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
</style>
