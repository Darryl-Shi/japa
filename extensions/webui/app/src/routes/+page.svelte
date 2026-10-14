<script lang="ts">
  import { fly } from "svelte/transition";
  import { Live } from "$lib/live.svelte";
  import { duration } from "$lib/motion";
  import TopBar from "$lib/components/TopBar.svelte";
  import Transcript from "$lib/components/Transcript.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import SecretCard from "$lib/components/SecretCard.svelte";
  import JobsPanel from "$lib/components/JobsPanel.svelte";
  import StatusSheet from "$lib/components/StatusSheet.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const live = new Live();
  $effect(() => live.start());

  let sheet = $state<"jobs" | "status" | undefined>();

  const activeJobs = $derived(
    live.jobs.filter((j) => j.status === "queued" || j.status === "running" || j.status === "needs_input").length,
  );

  // The secret card hides until the pending list changes (compared by ids), like `japa chat`'s Esc.
  const secretKey = $derived(live.secrets.map((s) => s.id).join(","));
  let dismissedKey = $state<string | undefined>();
  const secret = $derived(live.secrets.length > 0 && secretKey !== dismissedKey ? live.secrets[0] : undefined);

  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape" || e.defaultPrevented || sheet !== undefined || !live.busy) return;
    e.preventDefault();
    void live.abort();
  }
</script>

<svelte:window {onkeydown} />

<TopBar
  connection={live.connection}
  attached={live.attached}
  busy={live.busy}
  {activeJobs}
  user={data.user}
  onjobs={() => (sheet = "jobs")}
  onstatus={() => (sheet = "status")}
/>

<main class="column main" id="main">
  <h1 class="visually-hidden">Chat with japa</h1>
  <Transcript lines={live.lines} streaming={live.streaming} pending={live.pending} busy={live.busy} />
</main>

<footer class="dock">
  <div class="column stack">
    {#if secret}
      {#key secret.id}
        <div in:fly={{ y: 8, duration: duration(160) }}>
          <SecretCard
            request={secret}
            more={live.secrets.length - 1}
            onfulfil={(id, value) => live.fulfil(id, value)}
            ondecline={(id) => live.decline(id)}
            ondismiss={() => (dismissedKey = secretKey)}
          />
        </div>
      {/key}
    {/if}
    <Composer busy={live.busy} onsend={(text) => live.submit(text)} onstop={() => void live.abort()} />
  </div>
</footer>

{#if sheet === "jobs"}
  <JobsPanel jobs={live.jobs} onclose={() => (sheet = undefined)} />
{:else if sheet === "status"}
  <StatusSheet onclose={() => (sheet = undefined)} />
{/if}

<style>
  .column {
    width: 100%;
    max-width: calc(var(--column) + 2rem);
    margin: 0 auto;
    padding: 0 1rem;
  }

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .dock {
    position: sticky;
    bottom: 0;
    z-index: 5;
    padding: 0.75rem 0 max(0.9rem, env(safe-area-inset-bottom));
    background: linear-gradient(to bottom, transparent, var(--bg) 1.25rem);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
</style>
