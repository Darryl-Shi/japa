<script lang="ts" module>
  import type { Json } from "$lib/protocol";

  /** A settings property's JSON schema, as far as the form needs it. */
  export type Property = {
    type?: string | string[];
    enum?: Json[];
    anyOf?: { const?: Json; type?: string | string[] }[];
    default?: Json;
    description?: string;
    title?: string;
  };

  /** Its choices: its `enum`, or the `const`s of an `anyOf` of them; undefined when it isn't an enum. */
  export function choicesOf(schema: Property): Json[] | undefined {
    if (Array.isArray(schema.enum)) return schema.enum;
    const consts = schema.anyOf?.map((s) => s.const);
    return consts !== undefined && consts.length > 0 && consts.every((c) => c !== undefined) ? (consts as Json[]) : undefined;
  }

  /** Its main type (the first that isn't "null"). */
  export function typeOf(schema: Property): string | undefined {
    const types = [schema.type ?? (schema.anyOf ?? []).flatMap((s) => [s.type ?? []].flat())].flat();
    return types.find((t) => t !== "null");
  }
</script>

<script lang="ts">
  import type { Reply } from "$lib/settings.svelte";
  import ReplyNote from "./ReplyNote.svelte";

  // One extension setting, as a form control generated from its schema: boolean → switch; enum / anyOf consts →
  // select; integer / number → number field; string → text field; arrays and objects → a JSON field.
  let {
    id,
    prop,
    schema,
    value,
    readOnly = false,
    busy,
    reply,
    onset,
  }: {
    id: string;
    prop: string;
    schema: Property;
    value: Json | undefined;
    readOnly?: boolean;
    busy: boolean;
    reply: Reply | undefined;
    /** Sets the value; `undefined` unsets it. */
    onset: (value: Json | undefined) => void;
  } = $props();

  const choices = $derived(choicesOf(schema));
  const type = $derived(typeOf(schema));
  const current = $derived(value ?? schema.default);
  const kind = $derived(
    choices !== undefined
      ? "select"
      : type === "boolean"
        ? "switch"
        : type === "integer" || type === "number"
          ? "number"
          : type === "string"
            ? "text"
            : "json",
  );
  const shownDefault = $derived(schema.default === undefined ? undefined : JSON.stringify(schema.default));
  const label = $derived(schema.title ?? prop);
  let jsonError = $state<string | undefined>();

  function display(v: Json | undefined): string {
    if (v === undefined) return "not set";
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  function onsubmit(e: SubmitEvent): void {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const text = String(new FormData(form).get("value") ?? "");
    jsonError = undefined;
    if (kind === "text") return onset(text);
    if (kind === "number") {
      const n = Number(text);
      return onset(text.trim() !== "" && Number.isFinite(n) ? n : text);
    }
    try {
      onset(JSON.parse(text) as Json);
    } catch {
      jsonError = "That isn't valid JSON.";
    }
  }
</script>

<div class="field-row">
  {#if readOnly}
    <span class="set-label">{label}</span>
    <p class="set-mono value">{display(value)}</p>
    <p class="set-muted">Shown only: change it with <code>japa setup</code> or by asking the CoS.</p>
  {:else if kind === "switch"}
    <div class="switch-row">
      <span class="set-label" id="{id}-label">{label}</span>
      <button
        class="switch"
        type="button"
        role="switch"
        aria-checked={current === true}
        aria-labelledby="{id}-label"
        aria-describedby={schema.description ? `${id}-desc` : undefined}
        disabled={busy}
        onclick={() => onset(current !== true)}
      >
        <span class="knob" aria-hidden="true"></span>
      </button>
    </div>
    {#if schema.description}<p class="set-muted" id="{id}-desc">{schema.description}</p>{/if}
  {:else if kind === "select" && choices}
    <label class="set-label" for={id}>{label}</label>
    {#if schema.description}<p class="set-muted">{schema.description}</p>{/if}
    <div class="set-form">
      <select
        {id}
        class="field"
        disabled={busy}
        value={choices.findIndex((c) => JSON.stringify(c) === JSON.stringify(current))}
        onchange={(e) => onset(choices[Number(e.currentTarget.value)])}
      >
        {#if current === undefined}
          <option value={-1} disabled>Not set</option>
        {/if}
        {#each choices as choice, i (i)}
          <option value={i}>{display(choice)}</option>
        {/each}
      </select>
    </div>
  {:else}
    <label class="set-label" for={id}>{label}</label>
    {#if schema.description}<p class="set-muted">{schema.description}</p>{/if}
    <form class="set-form" {onsubmit}>
      {#if kind === "json"}
        <textarea
          {id}
          name="value"
          class="field"
          rows="3"
          spellcheck="false"
          placeholder={shownDefault ? `Default: ${shownDefault}` : "JSON"}
          value={value === undefined ? "" : JSON.stringify(value, null, 2)}
        ></textarea>
      {:else}
        <input
          {id}
          name="value"
          class="field"
          type={kind === "number" ? "number" : "text"}
          step={kind === "number" ? (type === "integer" ? "1" : "any") : undefined}
          placeholder={shownDefault ? `Default: ${display(schema.default)}` : ""}
          value={value === undefined ? "" : display(value)}
          autocomplete="off"
          spellcheck="false"
        />
      {/if}
      <button class="btn" type="submit" disabled={busy}>Save</button>
      {#if value !== undefined}
        <button class="btn ghost" type="button" disabled={busy} onclick={() => onset(undefined)}>Reset</button>
      {/if}
    </form>
    {#if jsonError}<p class="set-reply" data-error>{jsonError}</p>{/if}
  {/if}
  <ReplyNote {reply} />
</div>

<style>
  .value {
    margin: 0.15rem 0;
    font-size: var(--text-sm);
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .switch {
    position: relative;
    flex: none;
    width: 2.6rem;
    height: 1.5rem;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--pill);
    background: var(--gray-200);
    transition: background-color 120ms var(--ease);
  }

  .switch[aria-checked="true"] {
    background: var(--accent);
    border-color: var(--accent);
  }

  .knob {
    position: absolute;
    top: 50%;
    left: 0.15rem;
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    transform: translateY(-50%);
    transition: left 120ms var(--ease);
  }

  .switch[aria-checked="true"] .knob {
    left: calc(100% - 1.25rem);
    background: var(--accent-text);
  }

  .switch:disabled {
    opacity: 0.5;
  }

  .set-form select.field {
    flex: 0 1 16rem;
  }
</style>
