<script lang="ts">
  import type { Snippet } from "svelte";
  import { fly } from "svelte/transition";
  import { duration } from "$lib/motion";

  // A modal slide-over from the right (a full-screen sheet on narrow screens), on a native <dialog>:
  // the browser traps focus, makes the rest of the page inert and turns Esc into `cancel`.
  let {
    title,
    id,
    onclose,
    actions,
    children,
  }: { title: string; id: string; onclose: () => void; actions?: Snippet; children: Snippet } = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog?.showModal();
    return () => {
      dialog?.close();
      opener?.focus();
    };
  });

  function oncancel(e: Event): void {
    e.preventDefault();
    onclose();
  }

  // A click on the backdrop (the dialog box itself, outside the panel) closes it.
  function onclick(e: MouseEvent): void {
    if (e.target === dialog) onclose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="sheet" aria-modal="true" aria-labelledby="{id}-title" {oncancel} {onclick}>
  <div class="panel" in:fly|global={{ x: 24, duration: duration(180) }}>
    <header class="head">
      <h2 id="{id}-title" class="title">{title}</h2>
      {#if actions}{@render actions()}{/if}
      <button class="btn ghost icon" type="button" aria-label="Close {title}" onclick={onclose}>
        <span aria-hidden="true">×</span>
      </button>
    </header>
    <div class="body">
      {@render children()}
    </div>
  </div>
</dialog>

<style>
  .sheet {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    overflow: hidden;
  }

  .sheet::backdrop {
    background: var(--backdrop);
  }

  .panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(440px, 100%);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-left: 1px solid var(--border);
    box-shadow: var(--shadow);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0.75rem 0.75rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .title {
    margin: 0 auto 0 0;
    font-size: var(--text-md);
    font-weight: 600;
  }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 1.25rem 2rem;
  }

  @media (max-width: 640px) {
    .panel {
      width: 100%;
      border-left: 0;
    }
  }
</style>
