<script lang="ts">
  import type { ConfirmRequest } from "$lib/confirm.svelte";

  // A small modal confirmation on a native <dialog> (focus trapped, the rest inert, Esc = cancel). Cancel has focus
  // first, so Enter alone never confirms something destructive.
  let { request }: { request: ConfirmRequest } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let cancelButton: HTMLButtonElement | undefined = $state();

  $effect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog?.showModal();
    cancelButton?.focus();
    return () => {
      dialog?.close();
      opener?.focus();
    };
  });

  function oncancel(e: Event): void {
    e.preventDefault();
    request.resolve(false);
  }
</script>

<dialog
  bind:this={dialog}
  class="confirm"
  aria-modal="true"
  aria-labelledby="confirm-title"
  aria-describedby={request.message ? "confirm-message" : undefined}
  {oncancel}
>
  <h2 id="confirm-title" class="title">{request.title}</h2>
  {#if request.message}
    <p id="confirm-message" class="message">{request.message}</p>
  {/if}
  <div class="buttons">
    <button class="btn" type="button" bind:this={cancelButton} onclick={() => request.resolve(false)}>Cancel</button>
    <button class="btn primary" type="button" onclick={() => request.resolve(true)}>{request.action}</button>
  </div>
</dialog>

<style>
  .confirm {
    width: min(26rem, calc(100% - 2rem));
    padding: 1.1rem 1.25rem 1rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
  }

  .confirm::backdrop {
    background: var(--backdrop);
  }

  .title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    line-height: 1.4;
  }

  .message {
    margin: 0.4rem 0 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .buttons {
    margin-top: 1rem;
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
