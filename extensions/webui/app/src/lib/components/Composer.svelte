<script lang="ts">
  import { checkFiles, humanSize, isImage } from "$lib/files";
  import type { UploadProgress } from "$lib/live.svelte";
  import FileChip from "./FileChip.svelte";

  let {
    busy,
    disabled = false,
    upload,
    onsend,
    onstop,
  }: {
    busy: boolean;
    disabled?: boolean;
    /** The upload under way (from Live), shown as progress. */
    upload?: UploadProgress;
    /** Resolves false when the message couldn't be sent: its text and files come back into the composer. */
    onsend: (text: string, files: File[]) => Promise<boolean>;
    onstop: () => void;
  } = $props();

  /** A chosen file; `url`: an object URL for an image's thumbnail (revoked when the chip goes). */
  type Chosen = { key: number; file: File; url?: string };

  let text = $state("");
  let chosen = $state.raw<Chosen[]>([]);
  /** Why files were refused (a limit), shown inline until the next change. */
  let notice = $state<string | undefined>();
  /** A message with files is uploading: Send waits. */
  let sending = $state(false);
  let area: HTMLTextAreaElement | undefined = $state();
  let picker: HTMLInputElement | undefined = $state();
  let nextKey = 0;

  const canSend = $derived((text.trim() !== "" || chosen.length > 0) && !disabled && !sending);

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

  // Revoke the thumbnails still shown when the composer goes.
  $effect(() => () => {
    for (const c of chosen) if (c.url) URL.revokeObjectURL(c.url);
  });

  const choose = (file: File): Chosen => ({
    key: nextKey++,
    file,
    url: isImage(file.type) ? URL.createObjectURL(file) : undefined,
  });

  function clearChosen(): void {
    for (const c of chosen) if (c.url) URL.revokeObjectURL(c.url);
    chosen = [];
  }

  /** Adds files to the message (the picker, a paste, a drop on the page); refuses them all past a limit. */
  export function addFiles(files: File[]): void {
    if (files.length === 0) return;
    const problem = checkFiles([...chosen.map((c) => c.file), ...files]);
    if (problem !== undefined) {
      notice = `${problem}: ${files.length === 1 ? "that file wasn't" : "those files weren't"} added.`;
      return;
    }
    notice = undefined;
    chosen = [...chosen, ...files.map(choose)];
  }

  function remove(key: number): void {
    const gone = chosen.find((c) => c.key === key);
    if (gone?.url) URL.revokeObjectURL(gone.url);
    chosen = chosen.filter((c) => c.key !== key);
    notice = undefined;
  }

  async function send(): Promise<void> {
    if (!canSend) return;
    const files = chosen.map((c) => c.file);
    const problem = checkFiles(files);
    if (problem !== undefined) {
      notice = `${problem}.`;
      return;
    }
    const message = text;
    text = "";
    clearChosen();
    notice = undefined;
    sending = files.length > 0;
    let ok = false;
    try {
      ok = await onsend(message, files);
    } finally {
      sending = false;
    }
    if (ok) return;
    // Give the text back unless something new was typed meanwhile; the files go back ahead of any added since.
    if (text === "") text = message;
    if (files.length > 0) {
      chosen = [...files.map(choose), ...chosen];
      const over = checkFiles(chosen.map((c) => c.file));
      if (over !== undefined) notice = `${over}.`;
    }
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

  /** Files pasted from the clipboard (e.g. a screenshot) are attached; rich text copied with an image isn't. */
  function onpaste(e: ClipboardEvent): void {
    const data = e.clipboardData;
    if (!data || data.files.length === 0) return;
    if (data.types.includes("text/html") || data.types.includes("text/rtf")) return;
    e.preventDefault();
    addFiles(Array.from(data.files));
  }

  function onpicked(): void {
    if (!picker?.files) return;
    addFiles(Array.from(picker.files));
    // Picking the same file again still fires change.
    picker.value = "";
    area?.focus();
  }

  /** Focuses the message field. */
  export function focus(): void {
    area?.focus();
  }
</script>

<form class="composer" class:tall={chosen.length > 0 || notice || upload} {onsubmit} aria-label="Send a message">
  {#if upload}
    <div class="status" role="status">
      <span>Uploading {humanSize(upload.sent)} of {humanSize(upload.total)}</span>
      <progress max={Math.max(upload.total, 1)} value={upload.sent}></progress>
    </div>
  {/if}
  {#if notice}
    <p class="notice" role="alert">{notice}</p>
  {/if}
  {#if chosen.length > 0}
    <ul class="chips" aria-label="Attached files">
      {#each chosen as c (c.key)}
        <li>
          <FileChip
            name={c.file.name}
            mimeType={c.file.type}
            size={c.file.size}
            thumb={c.url}
            onremove={() => remove(c.key)}
          />
        </li>
      {/each}
    </ul>
  {/if}
  <div class="row">
    <input
      class="visually-hidden"
      type="file"
      multiple
      tabindex="-1"
      aria-hidden="true"
      bind:this={picker}
      onchange={onpicked}
    />
    <button
      class="btn ghost icon attach"
      type="button"
      aria-label="Attach files"
      title="Attach files"
      onclick={() => picker?.click()}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path
          d="m20 11.5-7.8 7.8a4.75 4.75 0 0 1-6.7-6.7l8-8a3.17 3.17 0 0 1 4.48 4.48l-8 8a1.58 1.58 0 0 1-2.24-2.24l7.4-7.4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <label class="visually-hidden" for="composer-input">Message</label>
    <textarea
      id="composer-input"
      bind:this={area}
      bind:value={text}
      {onkeydown}
      {onpaste}
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
  </div>
</form>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.4rem;
    border: 1px solid var(--border-strong);
    border-radius: 26px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .composer.tall {
    border-radius: 20px;
  }

  .composer:focus-within {
    border-color: var(--gray-400);
    outline: 2px solid var(--gray-400);
    outline-offset: 1px;
  }

  .row {
    display: flex;
    align-items: flex-end;
    gap: 0.35rem;
  }

  .attach {
    flex: none;
    color: var(--text-muted);
  }

  .attach:hover {
    color: var(--text);
  }

  .chips {
    list-style: none;
    margin: 0;
    padding: 0.2rem 0.2rem 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .chips li {
    min-width: 0;
    max-width: 100%;
  }

  .status,
  .notice {
    margin: 0;
    padding: 0.2rem 0.6rem 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .notice {
    color: var(--text);
    font-weight: 500;
  }

  progress {
    flex: 1;
    min-width: 4rem;
    height: 4px;
    border: 0;
    border-radius: var(--pill);
    background: var(--gray-200);
    overflow: hidden;
    appearance: none;
    -webkit-appearance: none;
  }

  progress::-webkit-progress-bar {
    background: var(--gray-200);
  }

  progress::-webkit-progress-value {
    background: var(--accent);
  }

  progress::-moz-progress-bar {
    background: var(--accent);
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
