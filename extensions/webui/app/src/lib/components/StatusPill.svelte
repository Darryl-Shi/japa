<script lang="ts">
  // A job's status as a small monochrome pill: the Jobs panel's rows and the transcript's job reports.
  import { jobStatusLabel } from "$lib/jobs";

  let { status }: { status: string } = $props();
</script>

<span class="pill" data-status={status}>{jobStatusLabel(status)}</span>

<style>
  .pill {
    flex: none;
    padding: 0.05rem 0.55rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--pill);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 1.5;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .pill[data-status="running"] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }

  .pill[data-status="needs_input"] {
    border: 1.5px solid var(--text);
    color: var(--text);
    font-weight: 600;
  }

  .pill[data-status="queued"] {
    border-style: dashed;
  }

  .pill[data-status="done"] {
    background: var(--gray-100);
    border-color: transparent;
  }

  .pill[data-status="failed"] {
    color: var(--text);
    font-weight: 700;
    text-decoration: line-through;
  }

  .pill[data-status="cancelled"] {
    border-color: transparent;
    color: var(--text-faint);
    text-decoration: line-through;
  }
</style>
