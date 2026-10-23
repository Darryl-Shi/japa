<script lang="ts">
  // A file's type icon (lib/files.ts fileIcon): line drawings in currentColor, like the top bar's icons.
  import { fileIcon } from "$lib/files";

  let { mimeType, size = 18 }: { mimeType: string; size?: number } = $props();

  const kind = $derived(fileIcon(mimeType));
</script>

<svg class="file-icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
  {#if kind === "image"}
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6" />
    <circle cx="9" cy="9.5" r="1.6" fill="currentColor" />
    <path d="m4.5 17.5 5-5 3.5 3.5 2.5-2.5 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
  {:else}
    <path
      d="M6.5 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5Z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
    />
    <path d="M13.5 3.5V8H18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
    {#if kind === "pdf"}
      <path d="M8.5 16.5v-4h1.6a1.2 1.2 0 0 1 0 2.4H8.5M13 12.5v4h.8a2 2 0 0 0 0-4Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
    {:else if kind === "text"}
      <path d="M8.5 12h7M8.5 14.75h7M8.5 17.5h4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    {:else if kind === "archive"}
      <path d="M11 6h1.5M11 8.5h1.5M11 11h1.5M10.5 13.5h2.5v3h-2.5Z" fill="none" stroke="currentColor" stroke-width="1.4" />
    {:else if kind === "audio"}
      <path d="M10.5 17V11.5l4.5-1v5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      <circle cx="9.5" cy="17" r="1.25" fill="currentColor" />
      <circle cx="14" cy="15.5" r="1.25" fill="currentColor" />
    {:else if kind === "video"}
      <path d="M10 11.5v5.5l4.5-2.75Z" fill="currentColor" />
    {/if}
  {/if}
</svg>

<style>
  .file-icon {
    flex: none;
    display: block;
  }
</style>
