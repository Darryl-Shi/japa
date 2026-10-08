// Sign-in flows in `japa setup` -- a model provider's (pi-ai) or an extension's `authorize` -- through a Prompter:
// links shown and opened in the browser, prompts asked in the terminal.
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { Cancelled, type Prompter } from "./prompt.ts";

/** Opens `url` with the desktop's opener; does nothing over SSH or without a desktop. */
export function openInBrowser(url: string): void {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
        ? "xdg-open"
        : undefined;
  if (command === undefined) return;
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No opener: the link is on screen.
  }
}

/**
 * One sign-in attempt's prompts: `asking` is `p`, except that quitting (`Cancelled`) at one of its questions also
 * aborts `signal` -- stopping the flow and its local callback server -- before rethrowing. `quit()` tells whether
 * that happened, so the caller can rethrow `Cancelled` rather than report the flow's own abort error. Make one per
 * attempt: once aborted, a signal stays aborted.
 */
export function quittable(p: Prompter): { asking: Prompter; signal: AbortSignal; quit: () => boolean } {
  const abort = new AbortController();
  const onQuit = (error: unknown): never => {
    if (error instanceof Cancelled) abort.abort(error);
    throw error;
  };
  const asking: Prompter = {
    ...p,
    select: (...args) => p.select(...args).catch(onQuit),
    text: (...args) => p.text(...args).catch(onQuit),
    secret: (...args) => p.secret(...args).catch(onQuit),
  };
  return { asking, signal: abort.signal, quit: () => abort.signal.aborted };
}

/** pi-ai's login prompts and notices, through `p`. */
export function interactionFor(p: Prompter, openUrl: (url: string) => void, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    prompt: async (q: AuthPrompt) => {
      switch (q.type) {
        case "select":
          return p.select(
            q.message,
            q.options.map((o) => ({ label: o.label, value: o.id, hint: o.description })),
          );
        case "secret": {
          const value = await p.secret(q.message, { signal: q.signal });
          if (value === "") throw new Error("nothing was entered");
          return value;
        }
        case "text":
        case "manual_code":
          return p.text(q.message, { placeholder: q.placeholder, signal: q.signal });
      }
    },
    notify: (event: AuthEvent) => {
      switch (event.type) {
        case "auth_url":
          p.box(event.instructions ?? "Open this link to sign in.", "Sign in");
          p.link(event.url);
          openUrl(event.url);
          break;
        case "device_code":
          p.box(`Open the link below and enter the code ${event.userCode}`, "Sign in");
          p.link(event.verificationUri);
          openUrl(event.verificationUri);
          break;
        case "info":
          p.note([event.message, ...(event.links ?? []).map((l) => `${l.label ?? "Link"}: ${l.url}`)].join("\n"));
          break;
        case "progress":
          p.note(event.message);
          break;
      }
    },
  };
}
