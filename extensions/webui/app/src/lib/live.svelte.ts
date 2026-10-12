// The page's live state: one EventSource on /api/events, applied to runes; plus the actions (POSTs).
import { API, type JobView, type Line, type LiveEvent, type SecretRequestView, type StatusView, type SubmitMode } from "$lib/protocol";

export type Connection = "connecting" | "live" | "reconnecting";

/** A message sent from this tab that hasn't shown up in the transcript yet. */
export type PendingMessage = { id: string; text: string; steer: boolean };

const SUBMIT_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A message id the server accepts (/^[A-Za-z0-9_-]{8,64}$/). Not crypto.randomUUID(): that needs a secure context,
 * and the UI may be opened over plain http on a Tailscale address.
 */
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const sameText = (a: string, b: string) => a.trim() === b.trim();

export class Live {
  lines = $state.raw<Line[]>([]);
  streaming = $state("");
  busy = $state(false);
  jobs = $state.raw<JobView[]>([]);
  secrets = $state.raw<SecretRequestView[]>([]);
  /** The surface is attached to the conversation (from the last snapshot). */
  attached = $state(true);
  connection = $state<Connection>("connecting");
  pending = $state.raw<PendingMessage[]>([]);

  #source: EventSource | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #backoff = 500;
  #stopped = false;
  #deltaBuffer = "";
  #deltaFrame: number | undefined;

  /** Opens the live stream; returns a function that closes it. */
  start(): () => void {
    this.#stopped = false;
    this.#open();
    return () => this.stop();
  }

  stop(): void {
    this.#stopped = true;
    this.#source?.close();
    this.#source = undefined;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    if (this.#deltaFrame !== undefined) cancelAnimationFrame(this.#deltaFrame);
  }

  #open(): void {
    if (this.#stopped) return;
    const source = new EventSource(API.events);
    this.#source = source;
    source.onmessage = (message: MessageEvent<string>) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(message.data) as LiveEvent;
      } catch {
        return;
      }
      this.apply(event);
    };
    source.onerror = () => {
      if (this.#source !== source) return;
      this.connection = "reconnecting";
      // EventSource retries by itself after a dropped stream; it gives up (CLOSED) on an HTTP error such as a
      // 401 (session gone) or a 503 (daemon restarting), so then decide what to do ourselves.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        this.#source = undefined;
        void this.#recover();
      }
    };
  }

  async #recover(): Promise<void> {
    try {
      const res = await fetch(API.status, { cache: "no-store" });
      if (res.status === 401) return toLogin();
    } catch {
      // daemon down: keep trying
    }
    if (this.#stopped) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
    this.#retryTimer = setTimeout(() => this.#open(), delay);
  }

  /** Applies one live event to the state. */
  apply(event: LiveEvent): void {
    if (event.type !== "delta") this.#flushDelta();
    // Conversation updates only come once the surface is attached (no event says so on its own).
    if (event.type === "lines" || event.type === "transcript" || event.type === "delta" || event.type === "busy") {
      this.attached = true;
    }
    switch (event.type) {
      case "snapshot": {
        const s = event.state;
        this.connection = "live";
        this.#backoff = 500;
        this.lines = s.lines;
        this.streaming = s.streaming;
        this.busy = s.busy;
        this.jobs = s.jobs;
        this.secrets = s.secrets;
        this.attached = s.connected;
        this.#settlePending(s.lines.slice(-20));
        break;
      }
      case "lines":
        this.lines = [...this.lines, ...event.lines];
        this.#settlePending(event.lines);
        break;
      case "transcript":
        this.lines = event.lines;
        this.streaming = event.streaming;
        this.busy = event.busy;
        this.#settlePending(event.lines.slice(-20));
        break;
      case "delta":
        // Batch token deltas into one update per frame: each update re-renders the streaming markdown.
        this.#deltaBuffer += event.text;
        this.#deltaFrame ??= requestAnimationFrame(() => {
          this.#deltaFrame = undefined;
          this.#flushDelta();
        });
        break;
      case "streaming":
        this.streaming = event.text;
        break;
      case "busy":
        this.busy = event.busy;
        break;
      case "jobs":
        this.jobs = event.jobs;
        break;
      case "secrets":
        this.secrets = event.pending;
        break;
    }
    // A steer not taken before the run ended (it was stopped) is dropped by the kernel: so is its bubble.
    if (!this.busy && this.pending.some((p) => p.steer)) this.pending = this.pending.filter((p) => !p.steer);
  }

  #flushDelta(): void {
    if (this.#deltaFrame !== undefined) {
      cancelAnimationFrame(this.#deltaFrame);
      this.#deltaFrame = undefined;
    }
    if (this.#deltaBuffer === "") return;
    this.streaming += this.#deltaBuffer;
    this.#deltaBuffer = "";
  }

  /** Drops the optimistic bubble of each pending message that now appears as a user line. */
  #settlePending(lines: Line[]): void {
    if (this.pending.length === 0) return;
    let pending = this.pending;
    for (const line of lines) {
      if (line.kind !== "user") continue;
      const i = pending.findIndex((p) => sameText(p.text, line.text));
      if (i >= 0) pending = pending.filter((_, j) => j !== i);
    }
    if (pending !== this.pending) this.pending = pending;
  }

  /** A note shown in the transcript (local to this tab; a reconnect's snapshot replaces it). */
  info(text: string): void {
    this.lines = [...this.lines, { kind: "info", text }];
  }

  /**
   * Sends a message: steers the reply while busy, else queues it as a follow-up. Retries network failures with the
   * same id, so the server ignores duplicates. Resolves false when it finally failed (the caller restores the text).
   */
  async submit(text: string): Promise<boolean> {
    const id = newId();
    const mode: SubmitMode = this.busy ? "steer" : "followUp";
    this.pending = [...this.pending, { id, text, steer: mode === "steer" }];
    const drop = () => (this.pending = this.pending.filter((p) => p.id !== id));
    for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS));
      let res: Response;
      try {
        res = await postJson(API.submit, { text, mode, id });
      } catch {
        continue;
      }
      if (res.ok) return true;
      drop();
      await this.#reportFailure(res);
      return false;
    }
    drop();
    this.info("Couldn't reach japa — your message wasn't sent.");
    return false;
  }

  async abort(): Promise<void> {
    await this.#post(API.abort, {});
  }

  /** Sends a secret's value once. The value is only ever an argument here: never stored. */
  async fulfil(requestId: string, value: string): Promise<boolean> {
    return this.#post(API.fulfil, { requestId, value });
  }

  async decline(requestId: string): Promise<boolean> {
    return this.#post(API.decline, { requestId });
  }

  async #post(url: string, body: Record<string, unknown>): Promise<boolean> {
    let res: Response;
    try {
      res = await postJson(url, body);
    } catch {
      this.info("Couldn't reach japa.");
      return false;
    }
    if (res.ok) return true;
    await this.#reportFailure(res);
    return false;
  }

  async #reportFailure(res: Response): Promise<void> {
    if (res.status === 401) return toLogin();
    let message = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error !== "") message = body.error;
    } catch {
      // not JSON
    }
    this.info(message);
  }
}

function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

/** The session is gone: back to the sign-in page. */
export function toLogin(): void {
  location.href = API.login;
}

/** GET /api/status, or `{ error }` (after sending the page to sign-in on a 401). */
export async function fetchStatus(): Promise<StatusView | { error: string }> {
  try {
    const res = await fetch(API.status, { cache: "no-store" });
    if (res.status === 401) {
      toLogin();
      return { error: "Signed out" };
    }
    if (!res.ok) return { error: `Couldn't load status (${res.status}).` };
    return (await res.json()) as StatusView;
  } catch {
    return { error: "Couldn't reach japa." };
  }
}
