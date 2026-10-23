// The page's live state: one EventSource on /api/events, applied to runes; plus the actions (POSTs).
import { API, type JobView, type Line, type LiveEvent, type SecretRequestView, type SubmitMode } from "$lib/protocol";
import { toLogin } from "$lib/api";
import { errorOf, isImage, sameFileNames } from "$lib/files";

export type Connection = "connecting" | "live" | "reconnecting";

/** A file of a pending message; `url`: an object URL of the local file, for an image's thumbnail. */
export type PendingFile = { name: string; size: number; mimeType: string; url?: string };

/** A message sent from this tab that hasn't shown up in the transcript yet. */
export type PendingMessage = { id: string; text: string; steer: boolean; files: PendingFile[] };

/** An upload's progress: bytes of the request body sent so far, of `total`. */
export type UploadProgress = { sent: number; total: number };

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
  /** The file upload under way (one at a time: the composer waits for it), if any. */
  upload = $state<UploadProgress | undefined>();

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
      // Any session-gated endpoint tells a lost session (401) from a daemon that's down or restarting.
      const res = await fetch(API.update, { cache: "no-store" });
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
    if (!this.busy && this.pending.some((p) => p.steer)) this.#setPending(this.pending.filter((p) => !p.steer));
  }

  /** Replaces the pending list, revoking the thumbnails of messages no longer in it. */
  #setPending(next: PendingMessage[]): void {
    for (const p of this.pending) {
      if (next.includes(p)) continue;
      for (const f of p.files) if (f.url) URL.revokeObjectURL(f.url);
    }
    this.pending = next;
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
      const files = line.files ?? [];
      const i = pending.findIndex((p) => sameText(p.text, line.text) && sameFileNames(p.files, files));
      if (i >= 0) pending = pending.filter((_, j) => j !== i);
    }
    if (pending !== this.pending) this.#setPending(pending);
  }

  /** A note shown in the transcript (local to this tab; a reconnect's snapshot replaces it). */
  info(text: string): void {
    this.lines = [...this.lines, { kind: "info", text }];
  }

  /**
   * Sends a message: steers the reply while busy, else queues it as a follow-up. Retries network failures with the
   * same id, so the server ignores duplicates. Resolves false when it finally failed (the caller restores the text
   * and files). With `files`, it's one multipart upload whose progress is `upload` meanwhile.
   */
  async submit(text: string, files: File[] = []): Promise<boolean> {
    const id = newId();
    const mode: SubmitMode = this.busy ? "steer" : "followUp";
    const shown: PendingFile[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      mimeType: f.type || "application/octet-stream",
      url: isImage(f.type) ? URL.createObjectURL(f) : undefined,
    }));
    this.pending = [...this.pending, { id, text, steer: mode === "steer", files: shown }];
    const drop = () => this.#setPending(this.pending.filter((p) => p.id !== id));
    try {
      for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS));
        let res: { ok: boolean; status: number; error: () => Promise<string | undefined> };
        try {
          if (files.length === 0) {
            const r = await postJson(API.submit, { text, mode, id });
            res = { ok: r.ok, status: r.status, error: () => r.json().then(errorOf, () => undefined) };
          } else {
            res = await this.#upload(text, mode, id, files);
          }
        } catch {
          continue;
        }
        if (res.ok) return true;
        drop();
        if (res.status === 401) {
          toLogin();
          return false;
        }
        const message =
          (await res.error()) ?? (res.status === 413 ? "Those files are too large to send." : undefined);
        this.info(message ?? `Request failed (${res.status}).`);
        return false;
      }
      drop();
      this.info("Couldn't reach japa — your message wasn't sent.");
      return false;
    } finally {
      this.upload = undefined;
    }
  }

  /** One multipart POST of the message and its files, reporting progress in `upload`; rejects on a network error. */
  #upload(
    text: string,
    mode: SubmitMode,
    id: string,
    files: File[],
  ): Promise<{ ok: boolean; status: number; error: () => Promise<string | undefined> }> {
    const form = new FormData();
    form.append("text", text);
    form.append("mode", mode);
    form.append("id", id);
    for (const f of files) form.append("file", f, f.name);
    const total = files.reduce((sum, f) => sum + f.size, 0);
    this.upload = { sent: 0, total };
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", API.submit);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        // e.total counts the multipart framing too: scale to the files' bytes, which is what the composer shows.
        const sent = e.lengthComputable && e.total > 0 ? Math.round((e.loaded / e.total) * total) : e.loaded;
        this.upload = { sent: Math.min(sent, total), total };
      };
      xhr.onload = () => {
        const body = xhr.responseText;
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          error: async () => {
            try {
              return errorOf(JSON.parse(body));
            } catch {
              return undefined;
            }
          },
        });
      };
      xhr.onerror = () => reject(new Error("network error"));
      xhr.onabort = () => reject(new Error("aborted"));
      xhr.ontimeout = () => reject(new Error("timeout"));
      xhr.send(form);
    });
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
