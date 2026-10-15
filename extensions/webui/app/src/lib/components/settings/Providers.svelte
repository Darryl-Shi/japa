<script lang="ts">
  import { onMount, tick } from "svelte";
  import { errorText, getJson, postJson } from "$lib/api";
  import { API, type FlowStart, type FlowView, type ProviderView } from "$lib/protocol";
  import { Loader, type Reply } from "$lib/settings.svelte";
  import ReplyNote from "./ReplyNote.svelte";
  import SignInFlow from "./SignInFlow.svelte";

  const providers = new Loader(() => getJson<ProviderView[]>(API.providers));
  onMount(() => void providers.load());

  // The provider whose API key field is open, the running flow (one at a time from this screen), and the last error.
  let keyFor = $state<string | undefined>();
  let flow = $state.raw<FlowView | undefined>();
  let reply = $state<Reply | undefined>();
  let starting = $state(false);

  function connection(p: ProviderView): { state: string; label: string } {
    if (!p.connected) return { state: "off", label: "not connected" };
    if (p.credential === "oauth") return { state: "connected", label: "signed in" };
    if (p.credential === "api_key") return { state: "connected", label: "API key" };
    return { state: "connected", label: "connected" };
  }

  async function start(provider: string, body: FlowStart): Promise<void> {
    if (starting) return;
    starting = true;
    reply = undefined;
    try {
      flow = await postJson<FlowView>(API.signinStart, body);
    } catch (error) {
      reply = { key: provider, text: errorText(error), error: true };
    } finally {
      starting = false;
    }
  }

  async function openKey(id: string): Promise<void> {
    keyFor = keyFor === id ? undefined : id;
    await tick();
    document.getElementById(`key-${id}`)?.focus();
  }

  async function submitKey(e: SubmitEvent, p: ProviderView): Promise<void> {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const key = String(new FormData(form).get("key") ?? "");
    form.reset();
    if (key.trim() === "") return;
    keyFor = undefined;
    await start(p.id, { kind: "provider", provider: p.id, method: "api_key", key });
  }

  function ended(): void {
    void providers.load();
  }
</script>

<div aria-busy={providers.loading}>
  <p class="set-muted intro">Connect a provider to pick its models in Models.</p>
  {#if providers.error}
    <p class="set-reply" data-error>{providers.error}</p>
  {/if}
  {#if providers.data}
    {#if providers.data.length === 0}
      <p class="set-empty">No providers.</p>
    {:else}
      <ul class="set-card">
        {#each providers.data as p (p.id)}
          {@const c = connection(p)}
          {@const mine = flow?.target === p.id}
          <li class="set-row">
            <div class="set-top">
              <span class="set-name">{p.name}</span>
              <span class="set-pill" data-state={c.state}>{c.label}</span>
            </div>
            {#if p.signIn?.subscription}<p class="set-muted">Sign-in uses your subscription.</p>{/if}
            {#if !mine}
              <div class="set-actions">
                {#if p.signIn}
                  <button
                    class="btn"
                    type="button"
                    disabled={starting || flow !== undefined}
                    onclick={() => start(p.id, { kind: "provider", provider: p.id, method: "oauth" })}
                  >
                    {p.signIn.label}
                  </button>
                {/if}
                {#if p.apiKey}
                  <button
                    class="btn"
                    type="button"
                    aria-expanded={keyFor === p.id}
                    disabled={flow !== undefined}
                    onclick={() => openKey(p.id)}
                  >
                    {p.credential === "api_key" ? "Replace API key" : "Enter API key"}
                  </button>
                {/if}
              </div>
            {/if}
            {#if keyFor === p.id && p.apiKey}
              <form class="set-form" onsubmit={(e) => submitKey(e, p)}>
                <label class="visually-hidden" for="key-{p.id}">{p.apiKey.label}</label>
                <input
                  id="key-{p.id}"
                  name="key"
                  class="field"
                  type="password"
                  placeholder={p.apiKey.label}
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                />
                <button class="btn primary" type="submit" disabled={starting}>Save</button>
                <button class="btn" type="button" onclick={() => (keyFor = undefined)}>Cancel</button>
              </form>
            {/if}
            {#if mine && flow}
              {#key flow.id}
                <SignInFlow {flow} onend={ended} onclose={() => (flow = undefined)} />
              {/key}
            {/if}
            <ReplyNote reply={reply?.key === p.id ? reply : undefined} />
          </li>
        {/each}
      </ul>
    {/if}
  {:else if providers.loading}
    <p class="set-empty">Loading…</p>
  {/if}
</div>

<style>
  .intro {
    margin: 0 0 0.75rem;
  }
</style>
