<script lang="ts">
  import type { Reply } from "$lib/settings.svelte";

  // The kernel's reply to an action (or its error), shown inline; announced politely.
  let { reply }: { reply: Reply | undefined } = $props();
</script>

<div aria-live="polite">
  {#if reply}
    <p class="set-reply" data-error={reply.error ? "" : undefined}>{reply.text}</p>
  {/if}
</div>
