<script lang="ts">
  // A file the CoS sent (send_file): a hairline card with an icon or an image preview, name and size, the caption as
  // markdown (rendered and sanitised like assistant text), Download, and Open (new tab) for images and PDFs.
  import type { FileView } from "$lib/protocol";
  import { fileUrl, humanSize, inlineType, isImage } from "$lib/files";
  import { downloadFile, openFile, type InfoFn } from "$lib/download";
  import { renderMarkdown } from "$lib/markdown";
  import FileIcon from "./FileIcon.svelte";

  let { file, caption, oninfo }: { file: FileView; caption?: string; oninfo: InfoFn } = $props();

  let broken = $state(false);
  const preview = $derived(isImage(file.mimeType) && !broken);
  const captionHtml = $derived(caption ? renderMarkdown(caption) : "");
</script>

<article class="file-card" aria-label="File: {file.name}">
  {#if preview}
    <img class="preview" src={fileUrl(file.id)} alt={file.name} loading="lazy" decoding="async" onerror={() => (broken = true)} />
  {/if}
  <div class="row">
    {#if !preview}
      <span class="icon"><FileIcon mimeType={file.mimeType} size={20} /></span>
    {/if}
    <div class="meta">
      <span class="name">{file.name}</span>
      {#if file.size !== undefined}<span class="size">{humanSize(file.size)}</span>{/if}
    </div>
    <div class="actions">
      {#if inlineType(file.mimeType)}
        <button class="btn" type="button" onclick={() => void openFile(file.id, oninfo)}>Open</button>
      {/if}
      <button class="btn" type="button" onclick={() => void downloadFile(file.id, file.name, oninfo)}>Download</button>
    </div>
  </div>
  {#if captionHtml !== ""}
    <div class="caption markdown">{@html captionHtml}</div>
  {/if}
</article>

<style>
  .file-card {
    max-width: min(100%, 480px);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }

  .preview {
    display: block;
    max-width: 100%;
    max-height: 320px;
    margin: 0 auto;
    object-fit: contain;
    background: var(--bg-soft);
    border-bottom: 1px solid var(--border);
  }

  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.65rem;
    padding: 0.6rem 0.7rem;
  }

  .icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--radius-sm);
    background: var(--gray-100);
    color: var(--text-muted);
  }

  .meta {
    flex: 1 1 8rem;
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.35;
  }

  .name {
    font-size: var(--text-sm);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .size {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .actions {
    display: flex;
    gap: 0.35rem;
    flex: none;
  }

  .actions .btn {
    min-height: 2rem;
    padding: 0.25rem 0.8rem;
  }

  .caption {
    padding: 0 0.85rem 0.7rem;
    font-size: var(--text-sm);
  }
</style>
