<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { ApiError, errorText, getJson, postJson } from "$lib/api";
  import { API, type FlowView } from "$lib/protocol";

  // A sign-in flow this tab started (a provider's login or an extension's authorize), followed live by polling:
  // its links, device codes and notes, and its open prompt as a form. Answers live only in the form field until
  // submitted; the field is cleared at once.
  let {
    flow: initial,
    onend,
    onclose,
  }: {
    flow: FlowView;
    /** Called once when the flow has an outcome (the parent reloads its data). */
    onend: (outcome: { ok: boolean; text: string }) => void;
    /** Hides the flow (after it ended). */
    onclose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let flow = $state.raw<FlowView>(initial);
  let error = $state<string | undefined>();
  let answered = $state<string | undefined>();
  let sending = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let ended = false;

  const url = () => `${API.signin}/${encodeURIComponent(flow.id)}`;
  const prompt = $derived(flow.prompt && flow.prompt.id !== answered ? flow.prompt : undefined);

  function end(outcome: { ok: boolean; text: string }): void {
    if (ended) return;
    ended = true;
    if (timer !== undefined) clearInterval(timer);
    onend(outcome);
  }

  async function poll(): Promise<void> {
    try {
      flow = await getJson<FlowView>(url());
      error = undefined;
      if (flow.outcome) end(flow.outcome);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        flow = { ...flow, prompt: undefined, outcome: { ok: false, text: "This sign-in ended." } };
        end(flow.outcome!);
      } else {
        error = errorText(e);
      }
    }
  }

  onMount(() => {
    if (flow.outcome) end(flow.outcome);
    else timer = setInterval(() => void poll(), 1000);
  });

  onDestroy(() => {
    if (timer !== undefined) clearInterval(timer);
    // Leaving the screen mid-flow cancels it, so a new sign-in isn't refused as "already running".
    if (!ended) void postJson(`${url()}/cancel`).catch(() => {});
  });

  async function cancel(): Promise<void> {
    try {
      await postJson(`${url()}/cancel`);
    } catch (e) {
      error = errorText(e);
    }
    await poll();
  }

  async function onsubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const current = prompt;
    if (!current || sending) return;
    const value = String(new FormData(form).get("value") ?? "");
    form.reset();
    if (value === "") return;
    sending = true;
    answered = current.id;
    try {
      await postJson(`${url()}/answer`, { promptId: current.id, value });
      error = undefined;
    } catch (err) {
      answered = undefined;
      error = errorText(err);
    } finally {
      sending = false;
    }
    void poll();
  }
</script>

<section class="flow" aria-label="Sign-in" aria-live="polite">
  {#if flow.events.length === 0 && !flow.prompt && !flow.outcome}
    <p class="set-muted">Starting…</p>
  {/if}
  {#each flow.events as event, i (i)}
    {#if event.type === "auth_url"}
      <p class="event">
        <a href={event.url} target="_blank" rel="noopener noreferrer" class="btn primary">Open the sign-in page</a>
      </p>
      {#if event.instructions}<p class="note">{event.instructions}</p>{/if}
    {:else if event.type === "device_code"}
      <div class="event">
        <p class="note">Go to <a href={event.verificationUri} target="_blank" rel="noopener noreferrer">{event.verificationUri}</a> and enter this code:</p>
        <p class="code">{event.userCode}</p>
      </div>
    {:else if event.type === "info"}
      <p class="note">
        {event.message}
        {#each event.links ?? [] as link (link.url)}
          {" "}<a href={link.url} target="_blank" rel="noopener noreferrer">{link.label ?? link.url}</a>
        {/each}
      </p>
    {:else}
      <p class="note progress">{event.message}</p>
    {/if}
  {/each}

  {#if prompt && !flow.outcome}
    {#key prompt.id}
      <form class="prompt" {onsubmit}>
        <label class="set-label" for="flow-{flow.id}-value">{prompt.message}</label>
        {#if prompt.type === "manual_code" && flow.kind === "provider"}
          <p class="set-muted">
            If your browser isn't on japa's computer, the sign-in page can't hand back to japa by itself: after
            signing in, copy the address you land on (or the code shown) and paste it here.
          </p>
        {/if}
        <div class="set-form">
          {#if prompt.type === "select"}
            <select id="flow-{flow.id}-value" name="value" class="field">
              {#each prompt.options ?? [] as option (option.id)}
                <option value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ""}</option>
              {/each}
            </select>
          {:else}
            <input
              id="flow-{flow.id}-value"
              name="value"
              class="field"
              type={prompt.type === "secret" ? "password" : "text"}
              placeholder={prompt.placeholder ?? (prompt.type === "manual_code" ? "Redirect URL or code" : "")}
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
            />
          {/if}
          <button class="btn primary" type="submit" disabled={sending}>{sending ? "Sending…" : "Submit"}</button>
        </div>
      </form>
    {/key}
  {/if}

  {#if error}
    <p class="set-reply" data-error>{error}</p>
  {/if}

  {#if flow.outcome}
    <p class="set-reply" data-error={flow.outcome.ok ? undefined : ""}>{flow.outcome.text}</p>
    <div class="set-actions">
      <button class="btn" type="button" onclick={onclose}>Done</button>
    </div>
  {:else}
    <div class="set-actions">
      <button class="btn" type="button" onclick={cancel}>Cancel sign-in</button>
    </div>
  {/if}
</section>

<style>
  .flow {
    margin-top: 0.75rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-soft);
  }

  .event {
    margin: 0 0 0.5rem;
  }

  .event .btn {
    text-decoration: none;
  }

  .note {
    margin: 0 0 0.5rem;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .progress {
    color: var(--text-muted);
  }

  .code {
    margin: 0.25rem 0 0.5rem;
    font-family: var(--font-mono);
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: 0.12em;
    user-select: all;
  }

  .prompt {
    margin-top: 0.5rem;
  }
</style>
