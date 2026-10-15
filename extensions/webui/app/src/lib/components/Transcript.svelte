<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import type { Attachment } from "svelte/attachments";
  import type { Line } from "$lib/protocol";
  import type { PendingMessage } from "$lib/live.svelte";
  import { renderMarkdown } from "$lib/markdown";
  import { duration } from "$lib/motion";
  import JobReport from "./JobReport.svelte";

  let {
    lines,
    streaming,
    pending,
    busy,
  }: { lines: Line[]; streaming: string; pending: PendingMessage[]; busy: boolean } = $props();

  const empty = $derived(lines.length === 0 && streaming === "" && pending.length === 0);
  const streamingHtml = $derived(streaming === "" ? "" : renderMarkdown(streaming));

  // Follow new content while the reader is at (or near) the bottom; leave them alone once they scroll up.
  let follow = true;
  const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;

  $effect(() => {
    const onScroll = () => (follow = nearBottom());
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  });

  $effect(() => {
    // Track everything that grows the transcript.
    void [lines.length, streamingHtml, pending.length, busy];
    if (!follow) return;
    // Hidden behind the Settings page: leave the page's scroll alone.
    if (document.getElementById("main")?.offsetParent === null) return;
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  });

  // Copy buttons inside rendered code blocks: handled by delegation (no inline handlers under the CSP).
  const copyButtons: Attachment<HTMLElement> = (node) => {
    const onClick = async (e: MouseEvent) => {
      const button = (e.target as Element | null)?.closest<HTMLButtonElement>("button[data-copy]");
      if (!button || !node.contains(button)) return;
      const code = button.parentElement?.querySelector("pre code")?.textContent ?? "";
      const ok = await copyText(code);
      button.textContent = ok ? "Copied" : "Copy failed";
      button.setAttribute("data-copied", "");
      setTimeout(() => {
        button.textContent = "Copy";
        button.removeAttribute("data-copied");
      }, 1500);
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  };

  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through
    }
    // navigator.clipboard needs a secure context; plain http on a LAN/Tailscale address doesn't have one.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "visually-hidden";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
</script>

<div class="transcript" {@attach copyButtons}>
  {#if empty}
    <div class="empty" in:fade={{ duration: duration(200) }}>
      <p class="greeting">What can I do for you?</p>
      <p class="sub">Ask anything. Replies, tool calls and job reports show up here.</p>
    </div>
  {:else}
    <ol class="lines" aria-label="Conversation">
      {#each lines as line, i (i)}
        <li class="line {line.kind}" in:fade={{ duration: duration(150) }}>
          {#if line.kind === "user"}
            <div class="bubble">{line.text}</div>
          {:else if line.kind === "assistant"}
            <div class="markdown">{@html renderMarkdown(line.text)}</div>
          {:else if line.kind === "tool"}
            <span class="chip">{line.text}</span>
          {:else if line.kind === "report"}
            <JobReport title={line.title} status={line.status} text={line.text} />
          {:else}
            <!-- info and note: a muted inline note. -->
            <p class="note">{line.text}</p>
          {/if}
        </li>
      {/each}
      {#if streaming !== ""}
        <li class="line assistant streaming" aria-busy="true">
          <div class="markdown">{@html streamingHtml}</div>
        </li>
      {:else if busy}
        <li class="line assistant thinking" in:fade={{ duration: duration(150) }}>
          <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
        </li>
      {/if}
      {#each pending as message (message.id)}
        <li class="line user pending" in:fly={{ y: 6, duration: duration(150) }}>
          <div class="bubble">{message.text}</div>
          <span class="visually-hidden">Sending…</span>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .transcript {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem 1rem;
    text-align: center;
  }

  .greeting {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .sub {
    margin: 0.4rem 0 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .lines {
    list-style: none;
    margin: 0;
    padding: 1.75rem 0 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .line {
    min-width: 0;
  }

  .line.user {
    display: flex;
    justify-content: flex-end;
  }

  .bubble {
    max-width: min(85%, 560px);
    padding: 0.6rem 1rem;
    border-radius: var(--radius-lg);
    border-bottom-right-radius: 6px;
    background: var(--bubble);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .pending .bubble {
    opacity: 0.55;
  }

  .line.tool {
    margin: -0.35rem 0;
  }

  .chip {
    display: inline-block;
    max-width: 100%;
    padding: 0.1rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--pill);
    background: var(--bg-soft);
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: top;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .note::before {
    content: "— ";
    color: var(--text-faint);
  }

  .dots {
    display: inline-flex;
    gap: 4px;
    padding: 0.5rem 0;
  }

  .dots span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--gray-400);
    animation: blink 1.2s ease-in-out infinite;
  }

  .dots span:nth-child(2) {
    animation-delay: 0.15s;
  }

  .dots span:nth-child(3) {
    animation-delay: 0.3s;
  }

  @keyframes blink {
    0%,
    80%,
    100% {
      opacity: 0.3;
    }
    40% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dots span {
      animation: none;
    }
  }
</style>
