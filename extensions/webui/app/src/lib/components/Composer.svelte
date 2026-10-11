<script lang="ts">
  let {
    busy,
    disabled = false,
    onsend,
    onstop,
  }: {
    busy: boolean;
    disabled?: boolean;
    /** Resolves false when the message couldn't be sent: its text comes back into the field. */
    onsend: (text: string) => Promise<boolean>;
    onstop: () => void;
  } = $props();

  let text = $state("");
  let area: HTMLTextAreaElement | undefined = $state();
  const canSend = $derived(text.trim() !== "" && !disabled);

  const MAX_HEIGHT = 200;

  function grow(): void {
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT)}px`;
    area.style.overflowY = area.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }

  $effect(() => {
    void text;
    grow();
  });

  async function send(): Promise<void> {
    if (!canSend) return;
    const message = text;
    text = "";
    const ok = await onsend(message);
    // Give the text back unless something new was typed meanwhile.
    if (!ok && text === "") text = message;
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    // Don't send while an IME is composing (Enter confirms the composition there).
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void send();
  }

  function onsubmit(e: SubmitEvent): void {
    e.preventDefault();
    void send();
  }

  /** Focuses the message field. */
  export function focus(): void {
    area?.focus();
  }
</script>

<form class="composer" {onsubmit} aria-label="Send a message">
  <label class="visually-hidden" for="composer-input">Message</label>
  <textarea
    id="composer-input"
    bind:this={area}
    bind:value={text}
    {onkeydown}
    rows="1"
    placeholder={busy ? "Steer the reply…" : "Message japa…"}
    autocomplete="off"
    enterkeyhint="send"
    aria-keyshortcuts="Enter"
  ></textarea>
  <div class="buttons">
    {#if busy}
      {#if canSend}
        <button class="btn send" type="submit" aria-label="Send (steers the current reply)">Send</button>
      {/if}
      <button class="btn primary" type="button" onclick={onstop} aria-keyshortcuts="Escape">Stop</button>
    {:else}
      <button class="btn primary" type="submit" disabled={!canSend}>Send</button>
    {/if}
  </div>
</form>

<style>
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 0.4rem 0.4rem 0.4rem 1.1rem;
    border: 1px solid var(--border-strong);
    border-radius: 26px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .composer:focus-within {
    border-color: var(--gray-400);
    outline: 2px solid var(--gray-400);
    outline-offset: 1px;
  }

  textarea {
    flex: 1;
    min-width: 0;
    min-height: 2.25rem;
    max-height: 200px;
    margin: 0;
    padding: 0.4rem 0;
    border: 0;
    background: transparent;
    resize: none;
    line-height: 1.45;
    overflow-y: hidden;
  }

  textarea:focus-visible {
    outline: none;
  }

  textarea::placeholder {
    color: var(--text-faint);
  }

  .buttons {
    display: flex;
    gap: 0.35rem;
    flex: none;
  }

  .buttons .btn {
    min-height: 2.25rem;
    padding: 0 1rem;
  }
</style>
