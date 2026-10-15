<script lang="ts">
  import { onMount, tick } from "svelte";
  import { getJson, postJson } from "$lib/api";
  import { API, type Json, type ModelView, type ProviderView, type ReplyView } from "$lib/protocol";
  import { Loader, Runner } from "$lib/settings.svelte";
  import ReplyNote from "./ReplyNote.svelte";
  import type { Section } from "./sections";

  let { go }: { go: (section: Section) => void } = $props();

  type Role = "cos" | "worker" | "consolidation";
  type Ref = { provider: string; modelId: string };
  const ROLES: { id: Role; label: string; note: string }[] = [
    { id: "cos", label: "CoS", note: "The model you chat with." },
    { id: "worker", label: "Worker", note: "The model background jobs run on." },
    { id: "consolidation", label: "Memory upkeep", note: "The model that tidies up memory." },
  ];
  const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

  const data = new Loader(async () => {
    const [values, providers] = await Promise.all([
      getJson<{ [key: string]: Json }>(API.values),
      getJson<ProviderView[]>(API.providers),
    ]);
    return { values, providers };
  });
  const runner = new Runner();
  onMount(() => void data.load());

  const models = $derived((data.data?.values.models ?? {}) as Partial<Record<Role, Ref>>);
  const thinking = $derived(
    String(((data.data?.values.jobs ?? {}) as { thinking?: string }).thinking ?? "medium"),
  );
  const connected = $derived((data.data?.providers ?? []).filter((p) => p.connected));
  const unconnected = $derived((data.data?.providers ?? []).filter((p) => !p.connected));

  // The open picker: which role, and (step 2) the provider whose models are listed.
  let picking = $state<Role | undefined>();
  let pickProvider = $state<ProviderView | undefined>();
  let modelList = $state.raw<ModelView[] | undefined>();
  let modelError = $state<string | undefined>();
  let filter = $state("");
  let pickerEl: HTMLElement | undefined = $state();

  const providerName = (id: string) => data.data?.providers.find((p) => p.id === id)?.name ?? id;
  const shown = $derived(
    (modelList ?? []).filter((m) => {
      const f = filter.trim().toLowerCase();
      return f === "" || m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f);
    }),
  );

  async function openPicker(role: Role): Promise<void> {
    picking = role;
    pickProvider = undefined;
    modelList = undefined;
    filter = "";
    await tick();
    pickerEl?.querySelector<HTMLElement>("button, a, input")?.focus();
  }

  function closePicker(): void {
    picking = undefined;
    pickProvider = undefined;
    modelList = undefined;
  }

  async function chooseProvider(p: ProviderView): Promise<void> {
    pickProvider = p;
    modelList = undefined;
    modelError = undefined;
    filter = "";
    try {
      modelList = await getJson<ModelView[]>(`${API.models}?provider=${encodeURIComponent(p.id)}`);
    } catch (error) {
      modelError = error instanceof Error ? error.message : String(error);
    }
    await tick();
    pickerEl?.querySelector<HTMLElement>("input, .model-choice")?.focus();
  }

  async function set(key: string, path: string, value: Json | undefined): Promise<void> {
    const body: { path: string; value?: Json } = value === undefined ? { path } : { path, value };
    const ok = await runner.run(key, async () => (await postJson<ReplyView>(API.set, body)).reply, () => data.load());
    if (ok && key.startsWith("model:")) closePicker();
  }

  function chooseModel(role: Role, provider: string, modelId: string): void {
    void set(`model:${role}`, `models.${role}`, { provider, modelId });
  }
</script>

<div aria-busy={data.loading}>
  {#if data.error}
    <p class="set-reply" data-error>{data.error}</p>
  {/if}
  {#if data.data}
    <ul class="set-card">
      {#each ROLES as role (role.id)}
        {@const ref = models[role.id]}
        <li class="set-row">
          <div class="set-top">
            <span class="set-name">{role.label}</span>
          </div>
          <p class="set-muted">{role.note}</p>
          <p class="current">
            {#if ref}
              <span class="set-mono">{providerName(ref.provider)} / {ref.modelId}</span>
            {:else if role.id === "cos"}
              <span class="set-muted">Not set.</span>
            {:else}
              <span class="set-muted">Same as CoS</span>
            {/if}
          </p>
          <div class="set-actions">
            <button
              class="btn"
              type="button"
              aria-expanded={picking === role.id}
              onclick={() => (picking === role.id ? closePicker() : openPicker(role.id))}
            >
              {picking === role.id ? "Close" : "Change"}
            </button>
            {#if role.id !== "cos" && ref}
              <button
                class="btn"
                type="button"
                disabled={runner.busy}
                onclick={() => set(`model:${role.id}`, `models.${role.id}`, undefined)}
              >
                Use CoS model
              </button>
            {/if}
          </div>

          {#if picking === role.id}
            <div class="picker" bind:this={pickerEl} role="group" aria-label="Choose the {role.label} model">
              {#if pickProvider === undefined}
                <p class="step">Pick a provider</p>
                {#if connected.length === 0}
                  <p class="set-empty">No provider is connected yet.</p>
                {:else}
                  <ul class="choices">
                    {#each connected as p (p.id)}
                      <li>
                        <button class="choice" type="button" onclick={() => chooseProvider(p)}>
                          <span class="tick" aria-hidden="true">{ref?.provider === p.id ? "✓" : ""}</span>
                          <span>{p.name}</span>
                          {#if ref?.provider === p.id}<span class="visually-hidden">(current)</span>{/if}
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if unconnected.length > 0}
                  <p class="set-muted more">
                    Not connected: {unconnected.map((p) => p.name).join(", ")}.
                    <button class="linkish" type="button" onclick={() => go("providers")}>Connect one in Providers</button>
                  </p>
                {/if}
              {:else}
                <div class="step-row">
                  <button class="btn ghost" type="button" onclick={() => (pickProvider = undefined)}>
                    <span aria-hidden="true">‹</span> Providers
                  </button>
                  <p class="step">{pickProvider.name}: pick a model</p>
                </div>
                {#if modelError}
                  <p class="set-reply" data-error>{modelError}</p>
                {:else if modelList === undefined}
                  <p class="set-empty">Loading models…</p>
                {:else if modelList.length === 0}
                  <p class="set-empty">This provider has no models to pick.</p>
                {:else}
                  {#if modelList.length > 10}
                    <label class="visually-hidden" for="model-filter-{role.id}">Filter models</label>
                    <input
                      id="model-filter-{role.id}"
                      class="field filter"
                      type="search"
                      placeholder="Filter models"
                      autocomplete="off"
                      bind:value={filter}
                    />
                  {/if}
                  <ul class="choices models">
                    {#each shown as m (m.id)}
                      {@const current = ref?.provider === pickProvider.id && ref.modelId === m.id}
                      <li>
                        <button
                          class="choice model-choice"
                          type="button"
                          disabled={runner.busy}
                          aria-current={current ? "true" : undefined}
                          onclick={() => chooseModel(role.id, pickProvider!.id, m.id)}
                        >
                          <span class="tick" aria-hidden="true">{current ? "✓" : ""}</span>
                          <span class="mname">{m.name}</span>
                          {#if m.name !== m.id}<span class="set-mono mid">{m.id}</span>{/if}
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              {/if}
            </div>
          {/if}
          <ReplyNote reply={runner.for(`model:${role.id}`)} />
        </li>
      {/each}
    </ul>

    <h3 class="set-group">Job thinking</h3>
    <div class="set-card">
      <div class="set-row">
        <label class="set-label" for="jobs-thinking">Thinking level for new jobs</label>
        <div class="set-form">
          <select
            id="jobs-thinking"
            class="field"
            value={thinking}
            disabled={runner.busy}
            onchange={(e) => set("thinking", "jobs.thinking", e.currentTarget.value)}
          >
            {#each THINKING as level (level)}
              <option value={level}>{level}</option>
            {/each}
          </select>
        </div>
        <ReplyNote reply={runner.for("thinking")} />
      </div>
    </div>
  {:else if data.loading}
    <p class="set-empty">Loading…</p>
  {/if}
</div>

<style>
  .current {
    margin: 0.35rem 0 0;
  }

  .current .set-mono {
    font-size: var(--text-sm);
  }

  .picker {
    margin-top: 0.75rem;
    padding: 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-soft);
  }

  .step {
    margin: 0 0 0.4rem;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .step-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }

  .step-row .step {
    margin: 0;
  }

  .choices {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .models {
    max-height: 22rem;
    overflow-y: auto;
  }

  .choice {
    width: 100%;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.45rem 0.6rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    font-size: var(--text-sm);
    text-align: left;
  }

  .choice:hover:not(:disabled) {
    background: var(--gray-100);
  }

  .tick {
    width: 1rem;
    flex: none;
    font-weight: 700;
  }

  .mname {
    font-weight: 500;
  }

  .mid {
    color: var(--text-muted);
  }

  .filter {
    margin-bottom: 0.4rem;
    min-height: 2.25rem;
    font-size: var(--text-sm);
  }

  .more {
    margin-top: 0.5rem;
  }

  .linkish {
    padding: 0;
    border: 0;
    background: none;
    font-size: inherit;
    color: var(--text);
    text-decoration: underline;
    text-decoration-color: var(--gray-400);
    text-underline-offset: 2px;
  }

  .set-form select.field {
    flex: 0 1 14rem;
  }
</style>
