<script lang="ts">
  import { onMount, tick } from "svelte";
  import { errorText, getJson, postJson } from "$lib/api";
  import { confirm } from "$lib/confirm.svelte";
  import { API, type ExtensionView, type FlowView, type Json, type ReplyView } from "$lib/protocol";
  import { Loader, Runner } from "$lib/settings.svelte";
  import ReplyNote from "./ReplyNote.svelte";
  import SchemaField, { type Property } from "./SchemaField.svelte";
  import SignInFlow from "./SignInFlow.svelte";

  const extensions = new Loader(() => getJson<ExtensionView[]>(API.extensions));
  const runner = new Runner();
  onMount(() => void extensions.load());

  /** Shown but not editable: a mistyped `owner` would shut its owner out of the chat. */
  const READ_ONLY = new Set(["owner"]);
  /** webui settings that can cut this page off. */
  const WEBUI_RISKY = new Set(["bind", "port"]);
  const PAGE_WARNING = "This page may stop working, and you may need to open the web UI again at its new address.";

  let selected = $state<string | undefined>();
  let flow = $state.raw<FlowView | undefined>();
  let flowError = $state<string | undefined>();
  let container: HTMLElement | undefined = $state();

  const current = $derived(extensions.data?.find((e) => e.name === selected));

  function stateOf(e: ExtensionView): string {
    return e.error !== undefined ? "error" : e.state;
  }

  function properties(e: ExtensionView): [string, Property][] {
    const all = (e.schema as { properties?: Record<string, Property> } | undefined)?.properties ?? {};
    return Object.entries(all).filter(([prop]) => prop !== "enabled");
  }

  async function open(name: string | undefined): Promise<void> {
    const from = selected;
    selected = name;
    flow = undefined;
    flowError = undefined;
    runner.reply = undefined;
    if (name !== undefined) void extensions.load();
    await tick();
    if (name !== undefined) container?.querySelector<HTMLElement>(".detail-title")?.focus();
    else if (from !== undefined) container?.querySelector<HTMLElement>(`[data-ext="${CSS.escape(from)}"]`)?.focus();
  }

  async function set(key: string, e: ExtensionView, prop: string, value: Json | undefined): Promise<void> {
    if (e.name === "webui" && WEBUI_RISKY.has(prop)) {
      if (!(await confirm(`Change the web UI's ${prop}?`, "Change it", PAGE_WARNING))) return;
    }
    const path = `extensions.${e.name}.${prop}`;
    const body: { path: string; value?: Json } = value === undefined ? { path } : { path, value };
    await runner.run(key, async () => (await postJson<ReplyView>(API.set, body)).reply, () => extensions.load());
  }

  async function turn(e: ExtensionView, on: boolean): Promise<void> {
    if (!on && e.name === "webui" && !(await confirm("Turn off the web UI?", "Turn off", PAGE_WARNING))) return;
    await set("enabled", e, "enabled", on ? undefined : false);
  }

  async function rollback(e: ExtensionView): Promise<void> {
    if (!(await confirm(`Roll back ${e.name} to last known good?`, "Roll back"))) return;
    await runner.run(
      "rollback",
      async () => (await postJson<ReplyView>(API.rollback, { extension: e.name })).reply,
      () => extensions.load(),
    );
  }

  async function submitSecret(ev: SubmitEvent, e: ExtensionView, name: string): Promise<void> {
    ev.preventDefault();
    const form = ev.currentTarget as HTMLFormElement;
    const value = String(new FormData(form).get("value") ?? "");
    form.reset();
    if (value === "") return;
    await runner.run(
      `secret:${name}`,
      async () => (await postJson<ReplyView>(API.secret, { extension: e.name, name, value })).reply,
      () => extensions.load(),
    );
  }

  async function signIn(e: ExtensionView): Promise<void> {
    flowError = undefined;
    try {
      flow = await postJson<FlowView>(API.signinStart, { kind: "extension", extension: e.name });
    } catch (error) {
      flowError = errorText(error);
    }
  }
</script>

<div bind:this={container} aria-busy={extensions.loading}>
  {#if extensions.error}
    <p class="set-reply" data-error>{extensions.error}</p>
  {/if}

  {#if selected === undefined}
    {#if extensions.data}
      {#if extensions.data.length === 0}
        <p class="set-empty">No extensions.</p>
      {:else}
        <ul class="set-card">
          {#each extensions.data as e (e.name)}
            <li class="set-row-item">
              <button class="set-row-button ext" type="button" data-ext={e.name} onclick={() => open(e.name)}>
                <span class="ext-main">
                  <span class="set-top">
                    <span class="set-name">{e.name}</span>
                    <span class="set-pill" data-state={stateOf(e)}>{stateOf(e)}</span>
                  </span>
                  {#if e.summary}<span class="set-muted line">{e.summary}</span>{/if}
                  {#if e.status}<span class="set-mono line">{e.status}</span>{/if}
                  {#if e.error}<span class="set-mono line err">{e.error}</span>{/if}
                </span>
                <span class="chev" aria-hidden="true">›</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if extensions.loading}
      <p class="set-empty">Loading…</p>
    {/if}
  {:else}
    <button class="btn ghost set-back" type="button" onclick={() => open(undefined)}>
      <span aria-hidden="true">‹</span> All extensions
    </button>
    {#if current}
      {@const e = current}
      <div class="set-top">
        <h3 class="detail-title" tabindex="-1">{e.name}</h3>
        <span class="set-pill" data-state={stateOf(e)}>{stateOf(e)}</span>
      </div>
      {#if e.summary}<p class="set-muted">{e.summary}</p>{/if}
      {#if e.status}<p class="set-mono status">{e.status}</p>{/if}
      {#if e.error}<p class="set-reply" data-error>Error: {e.error}</p>{/if}

      {#if e.secrets.length > 0}
        <h4 class="set-group">Secrets</h4>
        <ul class="set-card">
          {#each e.secrets as s (s.name)}
            <li class="set-row">
              <div class="set-top">
                <label class="set-label" for="secret-{e.name}-{s.name}">{s.name}</label>
                <span class="set-pill" data-state={s.set ? "on" : "not set up"}>{s.set ? "set" : "not set"}</span>
              </div>
              {#if s.description}<p class="set-muted">{s.description}</p>{/if}
              <form class="set-form" onsubmit={(ev) => submitSecret(ev, e, s.name)}>
                <input
                  id="secret-{e.name}-{s.name}"
                  name="value"
                  class="field"
                  type="password"
                  placeholder={s.set ? "New value (hidden)" : "Value (hidden)"}
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                />
                <button class="btn" type="submit" disabled={runner.busy}>{s.set ? "Replace" : "Set"}</button>
              </form>
              <ReplyNote reply={runner.for(`secret:${s.name}`)} />
            </li>
          {/each}
        </ul>
      {/if}

      {#if e.signIn}
        <h4 class="set-group">Sign in</h4>
        <div class="set-card">
          <div class="set-row">
            {#if flow}
              {#key flow.id}
                <SignInFlow {flow} onend={() => void extensions.load()} onclose={() => (flow = undefined)} />
              {/key}
            {:else}
              <button class="btn" type="button" onclick={() => signIn(e)}>Sign in</button>
            {/if}
            {#if flowError}<p class="set-reply" data-error>{flowError}</p>{/if}
          </div>
        </div>
      {/if}

      {#if properties(e).length > 0}
        <h4 class="set-group">Settings</h4>
        <ul class="set-card">
          {#each properties(e) as [prop, schema] (prop)}
            <li class="set-row">
              <SchemaField
                id="ext-{e.name}-{prop}"
                {prop}
                {schema}
                value={e.values[prop]}
                readOnly={READ_ONLY.has(prop)}
                busy={runner.busy}
                reply={runner.for(`prop:${prop}`)}
                onset={(value) => set(`prop:${prop}`, e, prop, value)}
              />
            </li>
          {/each}
        </ul>
      {/if}

      <h4 class="set-group">Manage</h4>
      <div class="set-actions manage">
        {#if e.state === "off"}
          <button class="btn" type="button" disabled={runner.busy} onclick={() => turn(e, true)}>Turn on</button>
        {:else}
          <button class="btn" type="button" disabled={runner.busy} onclick={() => turn(e, false)}>Turn off</button>
        {/if}
        {#if e.workspace}
          <button class="btn" type="button" disabled={runner.busy} onclick={() => rollback(e)}>
            Roll back to last known good
          </button>
        {/if}
      </div>
      <ReplyNote reply={runner.for("enabled") ?? runner.for("rollback")} />
    {:else if extensions.loading}
      <p class="set-empty">Loading…</p>
    {:else if extensions.data}
      <p class="set-empty">No extension {selected}.</p>
    {/if}
  {/if}
</div>

<style>
  .ext {
    align-items: flex-start;
  }

  .ext-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .line {
    margin: 0;
  }

  .err {
    color: var(--text);
    font-weight: 600;
  }

  .chev {
    align-self: center;
    color: var(--text-muted);
    font-size: var(--text-lg);
  }

  .detail-title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .status {
    margin: 0.35rem 0 0;
  }

  .manage {
    margin-top: 0;
  }
</style>
