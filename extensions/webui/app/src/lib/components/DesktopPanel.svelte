<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type RFB from "@novnc/novnc";
  import { errorText, getJson, postJson } from "$lib/api";
  import { API, type DesktopState, type DesktopView } from "$lib/protocol";
  import Sheet from "./Sheet.svelte";

  // The live desktop, through the web UI's own websocket proxy (/api/desktop/ws) with the bundled noVNC client.
  // View-only when it opens; Take control (per tab, reset on every open) sends mouse, keyboard and clipboard.
  // Connected only while the panel is open; reconnects by itself after a drop or a daemon restart.
  let {
    docked,
    onclose,
    onsettings,
  }: {
    /** Docked to the right of the chat (wide screens); else a full-screen sheet. */
    docked: boolean;
    onclose: () => void;
    /** Opens Settings → Extensions. */
    onsettings: () => void;
  } = $props();

  type Phase = "loading" | "unavailable" | "waiting" | "connecting" | "connected" | "reconnecting";

  const POLL_MS = 3000;
  const RETRY_MS = 2000;
  const MAX_RETRY_MS = 10_000;
  const STATE_TEXT: Record<DesktopState, string> = {
    ready: "Ready.",
    starting: "Starting the desktop…",
    building: "Building the desktop's image…",
    failed: "The desktop failed to start.",
    stopped: "The desktop isn't running.",
  };

  let phase = $state<Phase>("loading");
  let desktopState = $state<DesktopState | undefined>();
  let statusText = $state("");
  let error = $state<string | undefined>();
  let starting = $state(false);
  let control = $state(false);
  let copied = $state("");
  let pasteNote = $state<string | undefined>();
  let fullscreen = $state(false);

  let stage: HTMLElement | undefined = $state();
  let screen: HTMLElement | undefined = $state();
  let paste: HTMLTextAreaElement | undefined = $state();
  let copiedField: HTMLTextAreaElement | undefined = $state();

  let rfb: RFB | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry = RETRY_MS;
  let closed = false;

  function schedule(ms: number): void {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), ms);
  }

  /** Reads the desktop's state (and the VNC password); connects when it's ready, else polls. */
  async function refresh(): Promise<void> {
    timer = undefined;
    if (closed) return;
    let view: DesktopView;
    try {
      view = await getJson<DesktopView>(API.desktop);
    } catch (e) {
      if (closed) return;
      error = errorText(e);
      if (phase === "loading") phase = "reconnecting";
      return schedule(nextRetry());
    }
    if (closed) return;
    error = undefined;
    if (!view.available) {
      phase = "unavailable";
      desktopState = undefined;
      return schedule(POLL_MS * 2);
    }
    desktopState = view.state;
    statusText = view.text;
    if (view.state !== "ready") {
      phase = "waiting";
      return schedule(POLL_MS);
    }
    await connect(view.password);
  }

  function nextRetry(): number {
    const ms = retry;
    retry = Math.min(retry * 2, MAX_RETRY_MS);
    return ms;
  }

  async function connect(password: string): Promise<void> {
    if (!screen || closed) return;
    phase = phase === "reconnecting" ? "reconnecting" : "connecting";
    let RFBClass: typeof RFB;
    try {
      RFBClass = (await import("@novnc/novnc")).default;
    } catch (e) {
      error = `Couldn't load the desktop viewer: ${errorText(e)}`;
      return;
    }
    if (closed || !screen) return;
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${API.desktopWs}`;
    const client = new RFBClass(screen, url, { credentials: { password } });
    rfb = client;
    client.background = "transparent";
    client.scaleViewport = true;
    client.resizeSession = false;
    client.viewOnly = !control;
    client.addEventListener("connect", () => {
      if (rfb !== client) return;
      phase = "connected";
      error = undefined;
      retry = RETRY_MS;
      client.viewOnly = !control;
      if (control) client.focus();
    });
    client.addEventListener("credentialsrequired", () => client.sendCredentials({ password }));
    client.addEventListener("securityfailure", (e) => {
      const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
      error = `The desktop refused the connection${reason ? `: ${reason}` : "."}`;
    });
    client.addEventListener("clipboard", (e) => {
      copied = (e as CustomEvent<{ text: string }>).detail?.text ?? "";
    });
    client.addEventListener("disconnect", () => {
      if (rfb !== client) return;
      rfb = undefined;
      if (closed) return;
      phase = "reconnecting";
      // Re-read the state and password first: the daemon may have restarted, or the desktop stopped.
      schedule(nextRetry());
    });
  }

  async function start(): Promise<void> {
    starting = true;
    try {
      await postJson(API.desktopStart);
      desktopState = "starting";
      statusText = "";
      error = undefined;
    } catch (e) {
      error = errorText(e);
    } finally {
      starting = false;
    }
    schedule(1000);
  }

  function toggleControl(): void {
    control = !control;
    pasteNote = undefined;
    if (rfb) {
      rfb.viewOnly = !control;
      if (control) rfb.focus();
      else rfb.blur();
    }
  }

  function sendPaste(e: SubmitEvent): void {
    e.preventDefault();
    if (!paste || paste.value === "" || !rfb || !control) return;
    rfb.clipboardPasteFrom(paste.value);
    paste.value = "";
    pasteNote = "Sent to the desktop's clipboard: paste it there (Ctrl+V).";
  }

  async function copyCopied(): Promise<void> {
    try {
      await navigator.clipboard.writeText(copied);
      return;
    } catch {
      // no clipboard API (plain http): select it for the user to copy
    }
    copiedField?.focus();
    copiedField?.select();
  }

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage?.requestFullscreen();
    } catch {
      // not allowed here
    }
  }

  function onfullscreenchange(): void {
    fullscreen = document.fullscreenElement !== null && document.fullscreenElement === stage;
  }

  onMount(() => {
    void refresh();
  });

  onDestroy(() => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    const client = rfb;
    rfb = undefined;
    client?.disconnect();
    if (document.fullscreenElement && document.fullscreenElement === stage) void document.exitFullscreen();
  });

  const live = $derived(phase === "connected");
  const showScreen = $derived(phase === "connecting" || phase === "connected" || phase === "reconnecting");
</script>

<svelte:document {onfullscreenchange} />

{#snippet body()}
  <div class="desktop" bind:this={stage} data-control={control && live ? "" : undefined}>
    <div class="toolbar">
      <p class="state" aria-live="polite">
        {#if phase === "connected"}
          {#if control}
            <span class="control-mark">You're in control</span>
          {:else}
            <span class="dot" aria-hidden="true"></span> Live · view only
          {/if}
        {:else if phase === "connecting"}
          Connecting…
        {:else if phase === "reconnecting"}
          Reconnecting…
        {:else if phase === "loading"}
          Loading…
        {/if}
      </p>
      {#if phase === "connected" || (showScreen && control)}
        <button class="btn" class:primary={control} type="button" aria-pressed={control} onclick={toggleControl}>
          {control ? "Stop controlling" : "Take control"}
        </button>
      {/if}
      {#if showScreen}
        <button class="btn" type="button" onclick={toggleFullscreen}>{fullscreen ? "Exit full screen" : "Full screen"}</button>
      {/if}
    </div>

    {#if error}
      <p class="note error" role="alert">{error}</p>
    {/if}

    {#if phase === "unavailable"}
      <div class="message">
        <p><strong>The desktop isn't available.</strong></p>
        <p class="muted">Turn on the <span class="mono">desktop</span> extension in Settings → Extensions.</p>
        <button class="btn" type="button" onclick={onsettings}>Open Settings → Extensions</button>
      </div>
    {:else if phase === "waiting"}
      <div class="message" aria-live="polite">
        <p><strong>{desktopState ? STATE_TEXT[desktopState] : ""}</strong></p>
        {#if statusText}<p class="muted pre">{statusText}</p>{/if}
        {#if desktopState === "stopped" || desktopState === "failed"}
          <button class="btn primary" type="button" disabled={starting} onclick={start}>
            {starting ? "Starting…" : "Start desktop"}
          </button>
        {/if}
      </div>
    {/if}

    <!-- noVNC renders its canvas in here; it gets keyboard focus only in control mode. -->
    <div class="screen" class:hidden={!showScreen} bind:this={screen} aria-label="Live desktop" role={control ? "application" : "img"}></div>

    {#if control && live}
      <div class="tools">
        <form class="tool" onsubmit={sendPaste}>
          <label class="tool-label" for="desktop-paste">Paste to the desktop</label>
          <div class="row">
            <textarea id="desktop-paste" class="field" rows="2" spellcheck="false" bind:this={paste}></textarea>
            <button class="btn" type="submit">Send</button>
          </div>
          {#if pasteNote}<p class="muted small" aria-live="polite">{pasteNote}</p>{/if}
        </form>
        <div class="tool">
          <label class="tool-label" for="desktop-copied">Copied on the desktop</label>
          <div class="row">
            <textarea
              id="desktop-copied"
              class="field"
              rows="2"
              readonly
              placeholder="Text copied on the desktop shows here."
              value={copied}
              bind:this={copiedField}
            ></textarea>
            <button class="btn" type="button" disabled={copied === ""} onclick={copyCopied}>Copy</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#if docked}
  <aside class="dock" aria-labelledby="desktop-title">
    <header class="head">
      <h2 id="desktop-title" class="title">Desktop</h2>
      <button class="btn ghost icon" type="button" aria-label="Close Desktop" onclick={onclose}>
        <span aria-hidden="true">×</span>
      </button>
    </header>
    {@render body()}
  </aside>
{:else}
  <Sheet title="Desktop" id="desktop" {onclose} flush>
    {@render body()}
  </Sheet>
{/if}

<style>
  .dock {
    position: sticky;
    top: var(--bar-height, 3.4rem);
    align-self: flex-start;
    flex: none;
    width: clamp(380px, 50vw, 1200px);
    height: calc(100dvh - var(--bar-height, 3.4rem));
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--surface);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem 0.5rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .title {
    margin: 0 auto 0 0;
    font-size: var(--text-md);
    font-weight: 600;
  }

  .desktop {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }

  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .state {
    margin: 0 auto 0 0.25rem;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text);
  }

  .control-mark {
    padding: 0.1rem 0.6rem;
    border-radius: var(--pill);
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
  }

  .screen {
    position: relative;
    flex: 1;
    min-height: 12rem;
    background: var(--gray-100);
    overflow: hidden;
  }

  .screen.hidden {
    display: none;
  }

  /* A clear frame while the user is in control. */
  .desktop[data-control] .screen {
    outline: 2px solid var(--text);
    outline-offset: -2px;
  }

  .message {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 2rem 1.25rem;
    text-align: center;
  }

  .message p {
    margin: 0;
  }

  .message .btn {
    margin-top: 0.75rem;
  }

  .muted {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .small {
    margin: 0.25rem 0 0;
    font-size: var(--text-xs);
  }

  .pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .note {
    margin: 0.5rem 0.75rem 0;
    padding: 0.45rem 0.75rem;
    border: 1px solid var(--text);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
  }

  .tools {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.6rem;
    padding: 0.6rem 0.75rem max(0.75rem, env(safe-area-inset-bottom));
    border-top: 1px solid var(--border);
  }

  .tool-label {
    display: block;
    margin-bottom: 0.25rem;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
  }

  .row {
    display: flex;
    gap: 0.4rem;
    align-items: flex-start;
  }

  .row .field {
    flex: 1;
    min-width: 0;
    min-height: 2.25rem;
    padding: 0.35rem 0.7rem;
    font-size: var(--text-sm);
    resize: vertical;
  }

  .desktop:fullscreen {
    width: 100%;
    height: 100%;
  }
</style>
