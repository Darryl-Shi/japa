// Sign-in flows (a provider's login, an extension's authorize) as server-side objects the Settings tab follows: the
// events so far, the open prompt, the outcome. Answers to prompts are handed to the login and never kept: a flow's
// view carries no answer, and an API key typed in Settings answers the login's first `secret` prompt unseen.
import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "japa/sdk";
import type { FlowEvent, FlowPrompt, FlowStart, FlowView } from "./app/src/lib/protocol.ts";

/** A flow with no answer this long is cancelled. */
export const FLOW_IDLE_MS = 10 * 60_000;
/** A finished flow is kept this long for its tab to read the outcome. */
export const FLOW_KEEP_MS = 5 * 60_000;

/** What runs a flow: the login (or authorize) through `interaction`; its outcome line on success. */
export type FlowRunner = (start: FlowStart, interaction: AuthInteraction) => Promise<string>;

type OpenPrompt = { view: FlowPrompt; resolve(value: string): void; reject(error: Error): void; done(): void };

type Flow = {
  view: Omit<FlowView, "prompt">;
  prompts: OpenPrompt[];
  controller: AbortController;
  /** The API key typed in Settings, until it answers the first `secret` prompt. */
  key?: string;
  idle?: ReturnType<typeof setTimeout>;
  drop?: ReturnType<typeof setTimeout>;
};

export type Flows = {
  /** Starts a flow; throws `Already signing in to …` while one for the same target runs. */
  start(start: FlowStart, name?: string): FlowView;
  flow(id: string): FlowView | undefined;
  /** Throws for an unknown flow or a prompt that isn't open. */
  answer(id: string, promptId: string, value: string): void;
  cancel(id: string): void;
  /** Cancels every running flow and forgets them all. */
  stop(): void;
};

const targetOf = (s: FlowStart) => (s.kind === "provider" ? s.provider : s.extension);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The event as the UI shows it: known fields only. */
function eventView(e: AuthEvent): FlowEvent {
  switch (e.type) {
    case "auth_url":
      return { type: "auth_url", url: e.url, ...(e.instructions !== undefined && { instructions: e.instructions }) };
    case "device_code":
      return { type: "device_code", userCode: e.userCode, verificationUri: e.verificationUri };
    case "info":
      return {
        type: "info",
        message: e.message,
        ...(e.links && { links: e.links.map((l) => ({ url: l.url, ...(l.label !== undefined && { label: l.label }) })) }),
      };
    default:
      return { type: "progress", message: e.message };
  }
}

function promptView(p: AuthPrompt): FlowPrompt {
  const view: FlowPrompt = { id: randomUUID(), type: p.type, message: p.message };
  if (p.type === "select") view.options = p.options.map((o) => ({ ...o }));
  else if (p.placeholder !== undefined) view.placeholder = p.placeholder;
  return view;
}

export function createFlows(run: FlowRunner, options: { idleMs?: number; keepMs?: number } = {}): Flows {
  const idleMs = options.idleMs ?? FLOW_IDLE_MS;
  const keepMs = options.keepMs ?? FLOW_KEEP_MS;
  const flows = new Map<string, Flow>();
  /** The running flow per target. */
  const running = new Map<string, Flow>();

  const view = (f: Flow): FlowView => {
    // The newest open prompt: a manual_code prompt raced against a callback stays visible unless a newer one opens.
    const open = f.prompts.at(-1);
    return structuredClone({ ...f.view, ...(open && { prompt: open.view }) });
  };

  function idle(f: Flow) {
    clearTimeout(f.idle);
    f.idle = setTimeout(() => end(f, { ok: false, text: "Cancelled." }), idleMs);
    f.idle.unref?.();
  }

  /** Records the outcome (the first one wins), stops the flow and schedules it to be forgotten. */
  function end(f: Flow, outcome: { ok: boolean; text: string }) {
    if (f.view.outcome !== undefined) return;
    f.view.outcome = outcome;
    f.key = undefined;
    clearTimeout(f.idle);
    if (running.get(f.view.target) === f) running.delete(f.view.target);
    if (!f.controller.signal.aborted) f.controller.abort(new Error("Cancelled"));
    for (const p of f.prompts.splice(0)) p.reject(new Error("Cancelled"));
    f.drop = setTimeout(() => flows.delete(f.view.id), keepMs);
    f.drop.unref?.();
  }

  return {
    start(start, name) {
      const target = targetOf(start);
      if (running.has(target)) throw new Error(`Already signing in to ${name ?? target}.`);
      const f: Flow = {
        view: { id: randomUUID(), kind: start.kind, target, events: [] },
        prompts: [],
        controller: new AbortController(),
        ...(start.kind === "provider" && start.method === "api_key" && start.key !== undefined && { key: start.key }),
      };
      const signal = f.controller.signal;
      const interaction: AuthInteraction = {
        signal,
        notify(event) {
          if (f.view.outcome === undefined) f.view.events.push(eventView(event));
        },
        prompt(p) {
          if (f.view.outcome !== undefined || signal.aborted) return Promise.reject(new Error("Cancelled"));
          if (p.signal?.aborted) return Promise.reject(new Error("Prompt cancelled"));
          if (p.type === "secret" && f.key !== undefined) {
            const key = f.key;
            f.key = undefined;
            return Promise.resolve(key);
          }
          return new Promise<string>((resolve, reject) => {
            const onAbort = () => {
              open.done();
              reject(new Error("Prompt cancelled"));
            };
            const open: OpenPrompt = {
              view: promptView(p),
              resolve: (value) => {
                open.done();
                resolve(value);
              },
              reject: (error) => {
                open.done();
                reject(error);
              },
              done: () => {
                p.signal?.removeEventListener("abort", onAbort);
                const i = f.prompts.indexOf(open);
                if (i >= 0) f.prompts.splice(i, 1);
              },
            };
            p.signal?.addEventListener("abort", onAbort, { once: true });
            f.prompts.push(open);
          });
        },
      };
      flows.set(f.view.id, f);
      running.set(target, f);
      idle(f);
      // The start's key goes with `start` to the runner only through `interaction`.
      const safeStart: FlowStart = start.kind === "provider" ? { kind: "provider", provider: start.provider, method: start.method } : start;
      run(safeStart, interaction).then(
        (text) => end(f, { ok: true, text }),
        (error: unknown) => end(f, { ok: false, text: `Couldn't connect: ${message(error)}` }),
      );
      return view(f);
    },
    flow(id) {
      const f = flows.get(id);
      return f && view(f);
    },
    answer(id, promptId, value) {
      const f = flows.get(id);
      if (f === undefined) throw new Error("No such sign-in.");
      const open = f.prompts.find((p) => p.view.id === promptId);
      if (open === undefined) throw new Error("That question isn't open any more.");
      if (open.view.type === "select" && !open.view.options?.some((o) => o.id === value)) {
        throw new Error("Not one of the options.");
      }
      idle(f);
      open.resolve(value);
    },
    cancel(id) {
      const f = flows.get(id);
      if (f === undefined) throw new Error("No such sign-in.");
      end(f, { ok: false, text: "Cancelled." });
    },
    stop() {
      for (const f of flows.values()) {
        end(f, { ok: false, text: "Cancelled." });
        clearTimeout(f.drop);
      }
      flows.clear();
    },
  };
}
