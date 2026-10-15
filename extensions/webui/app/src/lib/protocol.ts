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

/** `Symbol.for(DESKTOP_VIEW_KEY)` on `globalThis` holds the desktop extension's `DesktopViewHandle`, when it's loaded. */
export const DESKTOP_VIEW_KEY = "japa.desktop.view";

/** The desktop's state for the Desktop panel. `stopped`: not running and not being started. */
export type DesktopState = "ready" | "starting" | "building" | "failed" | "stopped";

/**
 * What the `desktop` extension publishes (set in its `setup`, cleared on dispose); the web UI reads it per request
 * and imports nothing from `desktop`.
 */
export interface DesktopViewHandle {
  /** Where its noVNC websocket (websockify) listens: the desktop's bind address (127.0.0.1 for 0.0.0.0/unset). */
  target(): { host: string; port: number };
  /** The VNC password (the `desktop.vncPassword` secret, generated if unset). */
  password(): Promise<string>;
  /** Its state, and the desktop's status text (e.g. "Building the desktop's image…", a Docker error). */
  status(): { state: DesktopState; text: string };
  /** Starts it (`ready(true)`) in the background; does nothing while it's turned off. */
  start(): void;
  /** Whether it's turned on (`extensions.desktop.enabled` isn't false): off, the web UI treats it as unavailable. */
  enabled(): boolean;
}

/** `GET /api/desktop`: `available` false without the desktop extension; the password only when available. */
export type DesktopView =
  | { available: false }
  | { available: true; state: DesktopState; text: string; password: string };

/** One settings value, as JSON. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Settings → Overview. `counts`: extensions by state (an extension with an error counts as `error`). */
export type OverviewView = {
  model?: { provider: string; modelId: string };
  errors: { name: string; error: string }[];
  counts: { on: number; off: number; notSetUp: number; error: number };
};

/** An extension as Settings → Extensions shows it (the kernel's `ExtensionInfo`). */
export type ExtensionView = {
  name: string;
  summary?: string;
  state: "on" | "off" | "not set up";
  error?: string;
  status?: string;
  workspace: boolean;
  loaded: boolean;
  /** Has an `authorize` hook: Settings offers Sign in. */
  signIn: boolean;
  secrets: { name: string; description?: string; set: boolean }[];
  /** Its settings JSON schema (TypeBox), if any. */
  schema?: Json;
  values: { [key: string]: Json };
};

/** A model provider (the kernel's `ProviderInfo`), in setup's order. */
export type ProviderView = {
  id: string;
  name: string;
  credential?: "oauth" | "api_key";
  connected: boolean;
  signIn?: { label: string; subscription: boolean };
  apiKey?: { label: string };
};

export type ModelView = { id: string; name: string };

/** A schedule, as `schedule_list`'s details give it: a repeating one has `cron`, a once one `at`. */
export type ScheduleView = {
  id: string;
  text: string;
  cron?: string;
  at?: number;
  next: number;
  paused: boolean;
  label: string;
};

/** A logged change. `detail`: its how-to-use text. */
export type ChangeView = { id: string; title: string; at: number; detail: string };

/** The last recorded update; `running` as the kernel's liveness says (an interrupted one reads `interrupted`, its summary pointing to the update log). */
export type UpdateView = {
  last?: {
    state: "running" | "updated" | "up to date" | "failed" | "interrupted";
    started: number;
    finished?: number;
    from: string;
    to?: string;
    rollback: boolean;
    summary?: string;
    output?: string;
  };
};

/** `POST /api/update/check`: up to date when `commits` is empty. */
export type UpdateCheckView = { current: string; target: string; commits: string[]; activeJobs: number };

/** A kernel reply (e.g. `Set jobs.maxConcurrent to 4.` or `Not changed: …`), shown inline. */
export type ReplyView = { reply: string };

/** What a sign-in flow has shown so far. */
export type FlowEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "info"; message: string; links?: { label?: string; url: string }[] }
  | { type: "progress"; message: string };

/** A flow's open question; answered by `id`. `secret` is a password field. */
export type FlowPrompt = {
  id: string;
  type: "select" | "text" | "secret" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
};

/** A sign-in flow: a provider's login or an extension's authorize. `outcome` once it ended. */
export type FlowView = {
  id: string;
  kind: "provider" | "extension";
  /** The provider id or extension name. */
  target: string;
  events: FlowEvent[];
  prompt?: FlowPrompt;
  outcome?: { ok: boolean; text: string };
};

/** How to start a flow. `key`: an API key typed in Settings, answering the login's first `secret` prompt. */
export type FlowStart =
  | { kind: "provider"; provider: string; method: "oauth" | "api_key"; key?: string }
  | { kind: "extension"; extension: string };

/** Settings, backed by the kernel's `AdminContext`. Each method throws an `Error` with a user-facing message. */
export interface SettingsBridge {
  overview(): Promise<OverviewView>;
  /** The live merged settings. */
  values(): Promise<{ [key: string]: Json }>;
  set(path: string, value: Json | undefined): Promise<string>;
  extensions(): Promise<ExtensionView[]>;
  setSecret(extension: string, name: string, value: string): Promise<string>;
  rollback(extension: string): Promise<string>;
  providers(): Promise<ProviderView[]>;
  models(provider: string): Promise<ModelView[]>;
  schedules(): Promise<ScheduleView[]>;
  schedule(id: string, action: "pause" | "resume" | "remove"): Promise<string>;
  /** The newest 10. */
  changes(): Promise<ChangeView[]>;
  undo(id: string): Promise<string>;
  clearFinishedJobs(): Promise<string>;
  update(): Promise<UpdateView>;
  checkUpdate(): Promise<UpdateCheckView>;
  /** Starts the update to `to` (from the current commit) asked from `{ adapter: "webui", chat: "web" }`. */
  startUpdate(to: string): Promise<void>;
  /** Starts a Roll back to `to`; refused while an update runs. */
  rollbackUpdate(to: string): Promise<void>;
  /** Starts a sign-in flow; throws when one for the same provider/extension runs. */
  startFlow(start: FlowStart): FlowView;
  /** undefined for an unknown id. */
  flow(id: string): FlowView | undefined;
  /** Answers the flow's open prompt `promptId`; throws when it isn't open. */
  answer(id: string, promptId: string, value: string): void;
  cancel(id: string): void;
}

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
  /** Settings; undefined when the kernel gave the surface no `admin` (the endpoints answer 503). */
  settings?: SettingsBridge;
  /** The Desktop panel's view; `{ available: false }` without the desktop extension. */
  desktop(): Promise<DesktopView>;
  /** Starts the desktop; false without the desktop extension. */
  startDesktop(): boolean;
}

/**
 * HTTP API (all same-origin, all but the sign-in page and static assets need the session cookie; else 401):
 * - GET  /api/events                 text/event-stream of LiveEvent JSON
 * - POST /api/submit                 { text: string, mode: SubmitMode, id: string }  → 204
 * - POST /api/abort                  → 204
 * - POST /api/secrets/fulfil         { requestId: string, value: string }             → 204
 * - POST /api/secrets/decline        { requestId: string }                            → 204
 * Settings (503 `{ error }` when the surface has no admin context; every response `Cache-Control: no-store`):
 * - GET  /api/settings/overview      → OverviewView
 * - GET  /api/settings/values        → the live settings JSON
 * - POST /api/settings/set           { path: string, value?: Json } (absent value: unset)  → ReplyView
 * - GET  /api/settings/extensions    → ExtensionView[]
 * - POST /api/settings/secret        { extension, name, value }                       → ReplyView
 * - POST /api/settings/rollback      { extension }                                    → ReplyView
 * - GET  /api/settings/providers     → ProviderView[]
 * - GET  /api/settings/models?provider=<id> → ModelView[]
 * - GET  /api/settings/schedules     → ScheduleView[]
 * - POST /api/settings/schedule      { id, action: "pause" | "resume" | "remove" }    → ReplyView
 * - GET  /api/settings/changes       → ChangeView[]
 * - POST /api/settings/undo          { id }                                           → ReplyView
 * - POST /api/settings/clear-jobs    → ReplyView
 * - GET  /api/update                 → UpdateView
 * - POST /api/update/check           → UpdateCheckView
 * - POST /api/update/start           { to: string }  → 204 (409 `{ error }` when one runs)
 * - POST /api/update/rollback        { to: string }  → 204 (409 likewise)
 * - POST /api/signin/start           FlowStart → FlowView (409 when one for the same target runs)
 * - GET  /api/signin/<id>            → FlowView (404 unknown)
 * - POST /api/signin/<id>/answer     { promptId: string, value: string }  → 204 (409 when that prompt isn't open)
 * - POST /api/signin/<id>/cancel     → 204
 * Desktop:
 * - GET  /api/desktop                → DesktopView (`Cache-Control: no-store`: carries the VNC password)
 * - POST /api/desktop/start          → 204 (404 without the desktop extension)
 * - GET  /api/desktop/ws             websocket upgrade, proxied to the desktop's websockify (handled by the surface's
 *                                    server before the app: session cookie, Host and same Origin required)
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
  overview: "/api/settings/overview",
  values: "/api/settings/values",
  set: "/api/settings/set",
  extensions: "/api/settings/extensions",
  secret: "/api/settings/secret",
  rollback: "/api/settings/rollback",
  providers: "/api/settings/providers",
  models: "/api/settings/models",
  schedules: "/api/settings/schedules",
  schedule: "/api/settings/schedule",
  changes: "/api/settings/changes",
  undo: "/api/settings/undo",
  clearJobs: "/api/settings/clear-jobs",
  update: "/api/update",
  updateCheck: "/api/update/check",
  updateStart: "/api/update/start",
  updateRollback: "/api/update/rollback",
  signinStart: "/api/signin/start",
  signin: "/api/signin",
  desktop: "/api/desktop",
  desktopStart: "/api/desktop/start",
  desktopWs: "/api/desktop/ws",
  login: "/login",
} as const;
