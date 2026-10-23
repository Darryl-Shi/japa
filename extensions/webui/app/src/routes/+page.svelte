<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { MediaQuery } from "svelte/reactivity";
  import { Live } from "$lib/live.svelte";
  import { duration } from "$lib/motion";
  import { confirmer } from "$lib/confirm.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import Transcript from "$lib/components/Transcript.svelte";
  import Composer from "$lib/components/Composer.svelte";
  import SecretCard from "$lib/components/SecretCard.svelte";
  import JobsPanel from "$lib/components/JobsPanel.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import DesktopPanel from "$lib/components/DesktopPanel.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import type { Section } from "$lib/components/settings/sections";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const live = new Live();
  $effect(() => live.start());

  // Wide screens: Settings is a full-page view and the Desktop panel docks right of the chat; narrow: both are
  // full-screen sheets.
  const settingsPage = new MediaQuery("min-width: 760px", true);
  const desktopDock = new MediaQuery("min-width: 1000px", true);

  let jobsOpen = $state(false);
  let settingsOpen = $state(false);
  let settingsSection = $state<Section | undefined>();
  let desktopOpen = $state(false);

  const settingsWide = $derived(settingsOpen && settingsPage.current);
  const desktopDocked = $derived(desktopOpen && desktopDock.current);
  /** A modal sheet is open over the chat. */
  const overlay = $derived(
    jobsOpen || (settingsOpen && !settingsPage.current) || (desktopOpen && !desktopDock.current) || !!confirmer.request,
  );

  const activeJobs = $derived(
    live.jobs.filter((j) => j.status === "queued" || j.status === "running" || j.status === "needs_input").length,
  );

  // The secret card hides until the pending list changes (compared by ids), like `japa chat`'s Esc.
  const secretKey = $derived(live.secrets.map((s) => s.id).join(","));
  let dismissedKey = $state<string | undefined>();
  const secret = $derived(live.secrets.length > 0 && secretKey !== dismissedKey ? live.secrets[0] : undefined);

  function toggleSettings(): void {
    if (settingsOpen) {
      settingsOpen = false;
      return;
    }
    settingsSection = undefined;
    settingsOpen = true;
  }

  function openExtensions(): void {
    if (!desktopDock.current) desktopOpen = false;
    settingsSection = "extensions";
    settingsOpen = true;
  }

  // Files dragged anywhere over the chat attach to the message, with an overlay while they're over the page.
  let composer: Composer | undefined = $state();
  let dragDepth = 0;
  let dragging = $state(false);
  const carriesFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  /** The chat is what's showing (not Settings' page nor a sheet over it). */
  const canDrop = () => !settingsWide && !overlay;

  function ondragenter(e: DragEvent): void {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dragging = canDrop();
  }

  function ondragover(e: DragEvent): void {
    if (!carriesFiles(e)) return;
    // Always claim a file drag: a file dropped elsewhere would otherwise make the browser navigate to it.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = canDrop() ? "copy" : "none";
  }

  function ondragleave(e: DragEvent): void {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging = false;
  }

  function ondrop(e: DragEvent): void {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dragging = false;
    if (!canDrop() || !e.dataTransfer) return;
    composer?.addFiles(Array.from(e.dataTransfer.files));
    composer?.focus();
  }

  function ondragend(): void {
    dragDepth = 0;
    dragging = false;
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape" || e.defaultPrevented || overlay || settingsWide || !live.busy) return;
    e.preventDefault();
    void live.abort();
  }
</script>

<svelte:window {onkeydown} {ondragenter} {ondragover} {ondragleave} {ondrop} {ondragend} />

{#if dragging}
  <div class="drop" aria-hidden="true" transition:fade={{ duration: duration(120) }}>
    <p>Drop files to attach</p>
  </div>
{/if}

<TopBar
  connection={live.connection}
  attached={live.attached}
  busy={live.busy}
  {activeJobs}
  {desktopOpen}
  {settingsOpen}
  wide={settingsWide || desktopDocked}
  user={data.user}
  onjobs={() => (jobsOpen = true)}
  ondesktop={() => (desktopOpen = !desktopOpen)}
  onsettings={toggleSettings}
/>

<div class="workspace">
  <div class="primary">
    {#if settingsOpen}
      <Settings
        wide={settingsPage.current}
        connection={live.connection}
        bind:section={settingsSection}
        onclose={() => (settingsOpen = false)}
      />
    {/if}

    <div class="chat" hidden={settingsWide}>
      <main class="column main" id="main">
        <h1 class="visually-hidden">Chat with japa</h1>
        <Transcript
          lines={live.lines}
          streaming={live.streaming}
          pending={live.pending}
          busy={live.busy}
          oninfo={(text) => live.info(text)}
        />
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
          <Composer
            bind:this={composer}
            busy={live.busy}
            upload={live.upload}
            onsend={(text, files) => live.submit(text, files)}
            onstop={() => void live.abort()}
          />
        </div>
      </footer>
    </div>
  </div>

  {#if desktopOpen}
    <!-- Docked and sheet are different elements: remount (and reconnect) when the layout switches. -->
    {#key desktopDock.current}
      <DesktopPanel docked={desktopDock.current} onclose={() => (desktopOpen = false)} onsettings={openExtensions} />
    {/key}
  {/if}
</div>

{#if jobsOpen}
  <JobsPanel jobs={live.jobs} onclose={() => (jobsOpen = false)} />
{/if}

{#if confirmer.request}
  {#key confirmer.request}
    <ConfirmDialog request={confirmer.request} />
  {/key}
{/if}

<style>
  .drop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 1.5rem;
    background: var(--backdrop);
    pointer-events: none;
  }

  .drop p {
    margin: 0;
    padding: 2.5rem 3rem;
    border: 2px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .workspace {
    flex: 1;
    display: flex;
    align-items: stretch;
    min-width: 0;
  }

  .primary {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .chat {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .chat[hidden] {
    display: none;
  }

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
