import { type AuthEvent, type AuthInteraction, type AuthPrompt, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AuthorizeContext, JapaExtension } from "./extension.ts";
import { message } from "./loader.ts";

/** The chat sign-in's secret request is named `<extension>.authorize`. */
export const AUTHORIZE_SUFFIX = ".authorize";

export type ConnectDeps = {
  extensions: () => JapaExtension[];
  context: (extension: string) => AuthorizeContext;
  /** Adds a pending secret request (`addSecretRequest`) and resolves with the value once fulfilled. */
  ask: (name: string, why: string) => Promise<string>;
  /** Removes the pending request for `name` from the root. */
  withdraw: (name: string) => Promise<void>;
  /** Deletes the secret `name` from the store. */
  forget: (name: string) => Promise<void>;
  /** Submits `text` to the root as input `requestId`. */
  report: (text: string, requestId: string) => Promise<void>;
  /** Aborts when the daemon closes: every pending flow is cancelled, without touching the root again. */
  signal: AbortSignal;
};

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** What the CoS passes on for a `notify` event. */
function lines(event: AuthEvent): string[] {
  if (event.type === "auth_url") {
    return [`Send the user this link to sign in: ${event.url}`, ...(event.instructions ? [event.instructions] : [])];
  }
  return event.type === "info" || event.type === "progress" ? [event.message] : [];
}

/**
 * The CoS's `connect` tool: runs an extension's `authorize` hook in the background, its `secret`/`manual_code`
 * prompts becoming the masked secret request `<extension>.authorize`. Returns once the flow first asks or ends; the
 * outcome of a flow still running then is reported to the root when it ends. One flow per extension at a time.
 */
export function connectTool(deps: ConnectDeps): ToolRegistration {
  const flows = new Map<string, { lines: string[] }>();
  // Report ids must not repeat across restarts (a repeated requestId is dropped): a timestamp, kept increasing.
  let last = 0;
  const nextId = () => (last = Math.max(Date.now(), last + 1));

  /** Asks the user for `name` until `signals` abort, withdrawing the request then; the trimmed value. */
  const answer = (name: string, why: string, signals: AbortSignal[]) =>
    new Promise<string>((resolve, reject) => {
      const signal = AbortSignal.any(signals);
      if (signal.aborted) return reject(new Error("The sign-in was cancelled"));
      const onAbort = () => {
        // On close the request is left for the next boot to drop.
        if (!deps.signal.aborted) void deps.withdraw(name).catch(() => {});
        reject(new Error("The sign-in was cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Whenever a value arrives, even after an abort, it leaves the store at once.
      deps.ask(name, why).then(
        async (value) => {
          await deps.forget(name).catch(() => {});
          signal.removeEventListener("abort", onAbort);
          resolve(value.trim());
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });

  return defineTool({
    name: "connect",
    description:
      'Sign in to an extension that needs the user\'s account (e.g. "google"). Returns a link to send the user; ' +
      "you'll be told when sign-in finishes.",
    parameters: Type.Object({ extension: Type.String() }),
    execute: async ({ extension }) => {
      const authorize = deps.extensions().find((e) => e.name === extension)?.authorize;
      if (authorize === undefined) return reply(`${extension} has no sign-in.`);
      const running = flows.get(extension);
      if (running !== undefined) return reply([...running.lines, "Already signing in."].join("\n"));

      const flow = { lines: [] as string[] };
      flows.set(extension, flow);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      if (deps.signal.aborted) cancel();
      else deps.signal.addEventListener("abort", cancel, { once: true });
      const name = `${extension}${AUTHORIZE_SUFFIX}`;
      let asked!: () => void;
      const waiting = new Promise<void>((resolve) => (asked = resolve));
      const io: AuthInteraction = {
        signal: controller.signal,
        notify: (event) => void flow.lines.push(...lines(event)),
        prompt: async (q: AuthPrompt) => {
          if (q.type !== "secret" && q.type !== "manual_code") throw new Error("This sign-in needs japa setup");
          asked();
          return answer(name, q.message, q.signal ? [q.signal, controller.signal] : [controller.signal]);
        },
      };

      let returned = false;
      let outcome: string | undefined;
      const settled = (async () => {
        try {
          outcome = await authorize.run(deps.context(extension), io);
        } catch (error) {
          outcome = `couldn't connect: ${message(error)}`;
        }
        deps.signal.removeEventListener("abort", cancel);
        controller.abort(); // withdraws a prompt the flow left open
        flows.delete(extension);
        // Once the tool has replied, the outcome reaches the CoS only this way; not once the daemon has closed.
        if (returned && !deps.signal.aborted) {
          void deps.report(`[${extension}: ${outcome}]`, `authorize:${extension}:${nextId()}`).catch(() => {});
        }
      })();

      await Promise.race([waiting, settled]);
      returned = true;
      return reply([...flow.lines, outcome ?? "Waiting for the user to sign in."].join("\n"));
    },
  });
}
