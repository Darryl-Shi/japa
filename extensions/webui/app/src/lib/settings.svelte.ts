// Shared state helpers for the Settings screens: loading a screen's data, and running an action whose kernel reply
// (or error) is shown inline next to what was acted on.
import { errorText } from "$lib/api";

export type Reply = { key: string; text: string; error: boolean };

/** A kernel reply that means nothing changed. */
export const refused = (text: string) => text.startsWith("Not changed");

/** Loads a screen's data with `fetcher`; `load()` again after each action. */
export class Loader<T> {
  data = $state.raw<T | undefined>();
  error = $state<string | undefined>();
  loading = $state(false);
  #fetcher: () => Promise<T>;

  constructor(fetcher: () => Promise<T>) {
    this.#fetcher = fetcher;
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      this.data = await this.#fetcher();
      this.error = undefined;
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.loading = false;
    }
  }
}

/** Runs actions one at a time; keeps the last reply, keyed by what it was about. */
export class Runner {
  busy = $state(false);
  reply = $state<Reply | undefined>();

  /** Runs `action` (its string result is the reply), then `after` (e.g. a reload), whatever happened. */
  async run(key: string, action: () => Promise<string | void>, after?: () => Promise<void>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    let ok = true;
    try {
      const text = await action();
      if (typeof text === "string" && text !== "") {
        ok = !refused(text);
        this.reply = { key, text, error: !ok };
      } else {
        this.reply = undefined;
      }
    } catch (error) {
      ok = false;
      this.reply = { key, text: errorText(error), error: true };
    } finally {
      this.busy = false;
    }
    if (after) await after();
    return ok;
  }

  /** The reply for `key`, if the last one was about it. */
  for(key: string): Reply | undefined {
    return this.reply?.key === key ? this.reply : undefined;
  }
}

/** "3 min ago", "2 h ago", "5 d ago". */
export function age(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** A local date and time. */
export function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
