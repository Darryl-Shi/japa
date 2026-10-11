// The contract between the webui surface (../../../index.ts, running in the daemon) and its SvelteKit app.
// Pure types and constants, no imports: the extension imports this file as a type, the app as `$lib/protocol`.

/** `Symbol.for(BRIDGE_KEY)` on `globalThis` holds the live `WebuiBridge`; the surface sets it on every start(). */
export const BRIDGE_KEY = "japa.webui.bridge";

/** One transcript line, projected from the root conversation as `japa chat` does. */
export type Line = { kind: "user" | "assistant" | "tool" | "info"; text: string };

export type JobStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled";

/** A job as the Jobs panel shows it. `result`: done: summary, needs_input: question, failed: reason. */
export type JobView = {
  id: string;
  title: string;
  brief: string;
  status: JobStatus;
  progress?: string;
  result?: string;
  createdAt: number;
  updatedAt: number;
};

/** A pending secret request: never carries a value. */
export type SecretRequestView = { id: string; name: string; why: string; at: number };

/** What `japa status` shows. */
export type StatusView = {
  model?: { provider: string; modelId: string };
  extensions: { name: string; summary: string; provides: string[]; status?: string; state?: string }[];
  errors: { name: string; error: string }[];
};

/** The whole live state, sent first on every stream. `connected`: the surface is attached to the conversation. */
export type Snapshot = {
  lines: Line[];
  streaming: string;
  busy: boolean;
  jobs: JobView[];
  secrets: SecretRequestView[];
  connected: boolean;
};

/** One Server-Sent Event's `data` on `GET /api/events`: a snapshot first, then incremental updates. */
export type LiveEvent =
  | { type: "snapshot"; state: Snapshot }
  /** Lines appended to the transcript. */
  | { type: "lines"; lines: Line[] }
  /** The transcript replaced (the conversation was re-read). */
  | { type: "transcript"; lines: Line[]; streaming: string; busy: boolean }
  /** Text appended to the streaming reply. */
  | { type: "delta"; text: string }
  /** The streaming reply replaced (`""` when it finished). */
  | { type: "streaming"; text: string }
  | { type: "busy"; busy: boolean }
  | { type: "jobs"; jobs: JobView[] }
  | { type: "secrets"; pending: SecretRequestView[] };

export type SubmitMode = "steer" | "followUp";

/** What the surface hands the app; `hooks.server.ts` puts it on `event.locals.webui`. */
export interface WebuiBridge {
  /** Calls `send` with a snapshot now, then with every update; `close` when the surface stops. Returns unsubscribe. */
  subscribe(send: (e: LiveEvent) => void, close: () => void): () => void;
  /** Submits `text` from the web; `id` (client-made, kept across retries) makes a resubmission a no-op. */
  submit(text: string, mode: SubmitMode, id: string): Promise<void>;
  abort(): Promise<void>;
  /** Throws for an unknown request. */
  fulfil(requestId: string, value: string): Promise<void>;
  /** Throws for an unknown request. */
  decline(requestId: string): Promise<void>;
  status(): StatusView;
}

/**
 * HTTP API (all same-origin, all but the sign-in page and static assets need the session cookie; else 401):
 * - GET  /api/events             text/event-stream of LiveEvent JSON
 * - POST /api/submit             { text: string, mode: SubmitMode, id: string }  → 204
 * - POST /api/abort              → 204
 * - POST /api/secrets/fulfil     { requestId: string, value: string }             → 204
 * - POST /api/secrets/decline    { requestId: string }                            → 204
 * - GET  /api/status             → StatusView
 * Invalid input: 4xx with `{ error: string }`.
 * Sign-in (handled by the surface's own server, before the app): GET /login (the app's page), POST /login with a
 * form field `token` (303 to / with the cookie, or to /login?error=1), and /?token=<token> (303 to / without it).
 */
export const API = {
  events: "/api/events",
  submit: "/api/submit",
  abort: "/api/abort",
  fulfil: "/api/secrets/fulfil",
  decline: "/api/secrets/decline",
  status: "/api/status",
  login: "/login",
} as const;
