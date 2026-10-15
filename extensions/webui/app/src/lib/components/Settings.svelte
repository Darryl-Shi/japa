<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Connection } from "$lib/live.svelte";
  import Sheet from "./Sheet.svelte";
  import Overview from "./settings/Overview.svelte";
  import Models from "./settings/Models.svelte";
  import Providers from "./settings/Providers.svelte";
  import Extensions from "./settings/Extensions.svelte";
  import Schedules from "./settings/Schedules.svelte";
  import General from "./settings/General.svelte";
  import Changes from "./settings/Changes.svelte";
  import Update from "./settings/Update.svelte";
  import { SECTIONS, sectionLabel, type Section } from "./settings/sections";

  // The Settings area. Wide screens: a full-page view, the section list on the left. Narrow screens: a full-screen
  // sheet with the section list, drilling into a section (Back returns to the list). Each section fetches its data
  // when it opens and after each action.
  let {
    wide,
    connection,
    section = $bindable(),
    onclose,
  }: {
    wide: boolean;
    connection: Connection;
    /** The open section; undefined: the list (narrow) or Overview (wide). */
    section: Section | undefined;
    onclose: () => void;
  } = $props();

  const shown = $derived<Section | undefined>(section ?? (wide ? "overview" : undefined));
  let page: HTMLElement | undefined = $state();
  let sheetBody: HTMLElement | undefined = $state();

  async function go(next: Section | undefined): Promise<void> {
    const from = shown;
    section = next;
    await tick();
    if (wide) {
      page?.querySelector<HTMLElement>(".section-title")?.focus();
    } else if (next !== undefined) {
      sheetBody?.closest("dialog")?.querySelector<HTMLElement>(".back")?.focus();
    } else if (from !== undefined) {
      sheetBody?.querySelector<HTMLElement>(`[data-section="${from}"]`)?.focus();
    }
  }

  // The wide page takes focus when it opens (and gives it back to the opener when it closes).
  $effect(() => {
    if (!wide) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    untrack(() => page)?.querySelector<HTMLElement>(".page-title")?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  });

  function onkeydown(e: KeyboardEvent): void {
    if (!wide || e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    onclose();
  }
</script>

{#snippet content(id: Section)}
  {#key id}
    {#if id === "overview"}
      <Overview {go} />
    {:else if id === "models"}
      <Models {go} />
    {:else if id === "providers"}
      <Providers />
    {:else if id === "extensions"}
      <Extensions />
    {:else if id === "schedules"}
      <Schedules />
    {:else if id === "general"}
      <General />
    {:else if id === "changes"}
      <Changes />
    {:else}
      <Update {connection} />
    {/if}
  {/key}
{/snippet}

{#if wide}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section class="page" aria-labelledby="settings-title" bind:this={page} {onkeydown}>
    <header class="page-head">
      <h1 id="settings-title" class="page-title" tabindex="-1">Settings</h1>
      <button class="btn" type="button" onclick={onclose}>Back to chat</button>
    </header>
    <div class="layout">
      <nav class="nav" aria-label="Settings sections">
        <ul>
          {#each SECTIONS as s (s.id)}
            <li>
              <button
                class="nav-item"
                type="button"
                aria-current={shown === s.id ? "page" : undefined}
                onclick={() => go(s.id)}
              >
                {s.label}
              </button>
            </li>
          {/each}
        </ul>
      </nav>
      <div class="content">
        {#if shown}
          <h2 class="section-title" tabindex="-1">{sectionLabel(shown)}</h2>
          {@render content(shown)}
        {/if}
      </div>
    </div>
  </section>
{:else}
  {#snippet back()}
    <button class="btn ghost icon back" type="button" aria-label="Back to Settings" onclick={() => go(undefined)}>
      <span aria-hidden="true">‹</span>
    </button>
  {/snippet}
  <Sheet
    title={shown ? sectionLabel(shown) : "Settings"}
    id="settings"
    {onclose}
    leading={shown ? back : undefined}
  >
    <div bind:this={sheetBody}>
      {#if shown}
        {@render content(shown)}
      {:else}
        <ul class="set-card list">
          {#each SECTIONS as s (s.id)}
            <li class="set-row-item">
              <button class="set-row-button" type="button" data-section={s.id} onclick={() => go(s.id)}>
                <span class="grow">{s.label}</span>
                <span class="chev" aria-hidden="true">›</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </Sheet>
{/if}

<style>
  .page {
    flex: 1;
    width: 100%;
    max-width: 1080px;
    margin: 0 auto;
    padding: 1.25rem 1.25rem 3rem;
  }

  .page-head {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .page-title {
    margin: 0 auto 0 0;
    font-size: var(--text-xl);
    font-weight: 650;
    letter-spacing: -0.02em;
  }

  .layout {
    display: grid;
    grid-template-columns: 13rem minmax(0, 1fr);
    gap: 2rem;
    align-items: start;
  }

  .nav {
    position: sticky;
    top: 4.5rem;
  }

  .nav ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .nav-item {
    width: 100%;
    padding: 0.45rem 0.8rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
    text-align: left;
  }

  .nav-item:hover {
    background: var(--gray-100);
    color: var(--text);
  }

  .nav-item[aria-current="page"] {
    background: var(--gray-100);
    color: var(--text);
    font-weight: 600;
  }

  .content {
    min-width: 0;
    max-width: 44rem;
  }

  .section-title {
    margin: 0 0 1rem;
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .list {
    margin-top: 0.25rem;
  }

  .grow {
    flex: 1;
    font-weight: 500;
  }

  .chev {
    color: var(--text-muted);
    font-size: var(--text-lg);
  }
</style>
