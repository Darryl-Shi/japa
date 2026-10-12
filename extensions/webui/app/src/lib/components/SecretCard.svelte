<script lang="ts">
  import type { SecretRequestView } from "$lib/protocol";

  let {
    request,
    more,
    onfulfil,
    ondecline,
    ondismiss,
  }: {
    request: SecretRequestView;
    /** How many more requests are pending after this one. */
    more: number;
    onfulfil: (requestId: string, value: string) => Promise<boolean>;
    ondecline: (requestId: string) => Promise<boolean>;
    ondismiss: () => void;
  } = $props();

  // The value lives only in the input element; it's read on submit and cleared right away.
  let input: HTMLInputElement | undefined = $state();
  let sending = $state(false);

  async function onsubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!input || input.value === "" || sending) return;
    const id = request.id;
    sending = true;
    const sent = onfulfil(id, input.value);
    input.value = "";
    await sent;
    sending = false;
  }

  async function decline(): Promise<void> {
    if (sending) return;
    sending = true;
    if (input) input.value = "";
    await ondecline(request.id);
    sending = false;
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (input) input.value = "";
      ondismiss();
    }
  }
</script>

<section class="card" aria-labelledby="secret-title" aria-describedby="secret-why">
  <div class="head">
    <div class="text">
      <h2 id="secret-title" class="title">
        <span class="kicker">Secret requested</span>
        <span class="name">{request.name}</span>
      </h2>
      <p id="secret-why" class="why">{request.why}</p>
    </div>
    <button class="btn ghost icon" type="button" aria-label="Hide this request for now" onclick={ondismiss}>
      <span aria-hidden="true">×</span>
    </button>
  </div>
  <form class="row" {onsubmit}>
    <label class="visually-hidden" for="secret-value">Value for {request.name}</label>
    <input
      id="secret-value"
      class="field"
      type="password"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      placeholder="Value (hidden)"
      bind:this={input}
      {onkeydown}
    />
    <button class="btn primary" type="submit" disabled={sending}>Submit</button>
    <button class="btn" type="button" disabled={sending} onclick={decline}>Decline</button>
  </form>
  {#if more > 0}
    <p class="more">+{more} more</p>
  {/if}
</section>

<style>
  .card {
    padding: 0.9rem 1rem 0.9rem 1.1rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .head {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .title {
    margin: 0;
    display: flex;
    flex-direction: column;
    font-size: var(--text-md);
    line-height: 1.35;
  }

  .kicker {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .name {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .why {
    margin: 0.25rem 0 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  .row {
    margin-top: 0.75rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .row .field {
    flex: 1 1 12rem;
    min-width: 0;
    border-radius: var(--pill);
    padding-left: 1rem;
  }

  .row .btn {
    min-height: 2.5rem;
  }

  .more {
    margin: 0.5rem 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
