<script lang="ts">
  // One file as a chip: a type icon (or a small thumbnail for a raster image), its name and size.
  // - With `id` (a transcript file): a link that downloads it (HEAD-checked first, so a gone file shows the server's
  //   message through `oninfo` instead of navigating away).
  // - With `onremove` (the composer): a × button.
  // - Otherwise (a pending message's file): just shown; `thumb` is an object URL of the local image.
  import { fileUrl, humanSize, isImage } from "$lib/files";
  import { downloadFile, type InfoFn } from "$lib/download";
  import FileIcon from "./FileIcon.svelte";

  let {
    name,
    mimeType,
    size,
    id,
    thumb,
    oninfo,
    onremove,
  }: {
    name: string;
    mimeType: string;
    size?: number;
    id?: string;
    thumb?: string;
    oninfo?: InfoFn;
    onremove?: () => void;
  } = $props();

  let broken = $state(false);
  const src = $derived(broken ? undefined : (thumb ?? (id !== undefined && isImage(mimeType) ? fileUrl(id) : undefined)));
  const sizeText = $derived(size === undefined ? "" : humanSize(size));
  const label = $derived(sizeText === "" ? name : `${name}, ${sizeText}`);

  function onclick(e: MouseEvent): void {
    if (id === undefined) return;
    // Let modified clicks (new tab, save as…) through to the plain link.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void downloadFile(id, name, oninfo ?? (() => {}));
  }
</script>

{#snippet body()}
  {#if src}
    <img class="thumb" {src} alt="" loading="lazy" decoding="async" onerror={() => (broken = true)} />
  {:else}
    <span class="icon"><FileIcon {mimeType} size={16} /></span>
  {/if}
  <span class="text">
    <span class="name">{name}</span>
    {#if sizeText !== ""}<span class="size">{sizeText}</span>{/if}
  </span>
{/snippet}

{#if id !== undefined}
  <a class="file-chip link" href={fileUrl(id, true)} download={name} title="Download {name}" aria-label="Download {label}" {onclick}>
    {@render body()}
  </a>
{:else}
  <span class="file-chip" title={name}>
    {@render body()}
    {#if onremove}
      <button class="remove" type="button" aria-label="Remove {name}" onclick={onremove}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
    {/if}
  </span>
{/if}

<style>
  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    max-width: 100%;
    min-width: 0;
    padding: 0.3rem 0.65rem 0.3rem 0.35rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: var(--text-sm);
    line-height: 1.3;
    text-decoration: none;
    vertical-align: top;
  }

  .file-chip.link {
    transition: background-color 120ms var(--ease), border-color 120ms var(--ease);
  }

  .file-chip.link:hover {
    background: var(--gray-50);
    border-color: var(--border-strong);
  }

  .icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-sm);
    background: var(--gray-100);
    color: var(--text-muted);
  }

  .thumb {
    flex: none;
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-sm);
    object-fit: cover;
    background: var(--gray-100);
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .name {
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .size {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .remove {
    flex: none;
    display: grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    margin: 0 -0.3rem 0 0.1rem;
    padding: 0;
    border: 0;
    border-radius: var(--pill);
    background: transparent;
    color: var(--text-muted);
  }

  .remove:hover {
    background: var(--gray-100);
    color: var(--text);
  }
</style>
