# Google extension and `authorize` hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `authorize` manifest hook that japa runs from `japa setup` and from chat (`connect`), and a packaged
`google` extension (Gmail, Drive, Calendar, Contacts, Tasks + `google_request`) that signs in through it.

**Architecture:** The kernel gains an optional `authorize: { run(ctx, io), connected(ctx) }` on `JapaExtension`; setup
drives `run` through the existing pi-ai `AuthInteraction` adapter, and a new CoS kernel tool `connect` drives it over
secret requests. `extensions/google` implements PKCE + loopback sign-in, token refresh, an authorized REST client,
and one tool per service whose handlers are pure functions of an `Api` interface (tested with a fake `Api`).

**Tech Stack:** TypeScript (Node 24, ESM, `.ts` imports), pi-ai / pi-durable, TypeBox via `Type`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-japa-google-design.md`

## Global Constraints

- No new npm dependencies. Google REST over global `fetch`; loopback listener with `node:http`.
- Packaged extension files import japa APIs from `../../src/sdk.ts` (as `extensions/parallel/index.ts` does).
- Tool parameter schemas must pass `schemaProblems` (`src/kernel/tool-schema.ts`): no tuples. Use one flat
  `Type.Object` with `action: StringEnum([...])` and optional fields, like `extensions/desktop/browser.ts`.
- Tools never throw to the CoS: every failure becomes a reply `{ content: [{ type: "text", text }] }`.
- Tool output truncated at 50,000 characters as `${text.slice(0, 50000)}\n[truncated: N more characters]` (same as
  `extensions/web/index.ts`).
- Secret names: `google.clientId`, `google.clientSecret`, `google.token` (`generated: true`). Chat sign-in request
  name: `<extension>.authorize`.
- Scopes, exactly: `openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive
  https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/tasks`.
- Sign-in gives up after 10 minutes; access token refreshed when it expires within 60 s.
- Files saved to `<home>/attachments/google/<YYYY-MM-DD>/<name>`, numeric suffix (`name (1).ext`) on collision.
- Code style: match the repo (2-space, double quotes, ~120 cols, short why-comments, `reply` helper).
- Full suite (`npx vitest --run`) and `npm run typecheck` must pass at the end of every task.

## Review Focus

1. **A pasted value that isn't a URL** (just the `code`, or a URL with extra whitespace) — trim; accept a bare code
   as the code with no state check only if it has no `?`/`=`; otherwise fail "That isn't the sign-in address".
   Test in Task 4.
2. **Concurrent tool calls when the token is near expiry** — exactly one refresh request. Test in Task 4.
3. **Non-ASCII subjects / names in attachments** — RFC 2047 encoding; filenames with `"` or non-ASCII use RFC 2231
   `filename*=UTF-8''…`. Test in Task 5.
4. **Gmail message whose body is only HTML, or nested multipart/alternative inside multipart/mixed** — walk parts
   recursively, prefer `text/plain`, else HTML through `htmlToText`. Test in Task 6.
5. **The chat flow outliving the request**: the user ignores the link, the loopback wins, or the daemon restarts —
   the `<ext>.authorize` request must not linger. Tests in Task 3.

---

### Task 1: `authorize` in the manifest

**Files:**
- Modify: `src/kernel/extension.ts`, `src/sdk.ts`
- Test: `test/extension.test.ts`

**Interfaces:**
- Produces (in `src/kernel/extension.ts`):
  ```ts
  export type AuthorizeContext = {
    home: string;
    settings(): JsonObject;
    secret(name: string): Promise<string | undefined>;
    setSecret(name: string, value: string): Promise<void>;
  };
  export type Authorize = {
    run(ctx: AuthorizeContext, io: AuthInteraction): Promise<string>;
    connected(ctx: AuthorizeContext): Promise<boolean>;
  };
  // JapaExtension gains: authorize?: Authorize;
  ```
  `AuthInteraction` from `@earendil-works/pi-ai`. `src/sdk.ts` additionally exports types `AuthorizeContext`,
  `Authorize`, and re-exports `AuthInteraction`, `AuthPrompt`, `AuthEvent` (types) from pi-ai.

- [ ] **Step 1: Failing tests** in `test/extension.test.ts`: `validateExtension({ name: "x", summary: "s", authorize:
  { run: async () => "ok", connected: async () => true } })` → `[]`; `authorize: { run: async () => "ok" }` →
  contains `"authorize.connected must be a function"`; `authorize: "nope"` → contains `"authorize must be an object
  with run and connected functions"`.
- [ ] **Step 2:** `npx vitest --run test/extension.test.ts` — FAIL.
- [ ] **Step 3:** Add the types and the checks (messages above; `authorize.run must be a function` likewise).
- [ ] **Step 4:** Tests and `npm run typecheck` pass.
- [ ] **Step 5:** Commit `feat(kernel): authorize hook in the extension manifest`.

### Task 2: `japa setup` runs `authorize`

**Files:**
- Create: `src/cli/auth-interaction.ts` (moved from `src/cli/models-step.ts`: `openInBrowser`, `interactionFor`)
- Modify: `src/cli/models-step.ts` (import them), `src/cli/configure.ts`
- Test: `test/configure.test.ts`

**Interfaces:**
- Consumes: Task 1 `Authorize`, `AuthorizeContext`.
- Produces:
  - `export function interactionFor(p: Prompter, openUrl: (url: string) => void, signal: AbortSignal): AuthInteraction`
    and `export function openInBrowser(url: string): void` in `src/cli/auth-interaction.ts` (bodies unchanged).
  - `configureExtension(ctx, p, e, opts?: { openUrl?: (url: string) => void })` — default `openInBrowser`.
  - `export function authorizeContext(ctx: SetupContext, e: JapaExtension): AuthorizeContext` in `configure.ts`
    (`settings()` = `readUserSettings(home).extensions?.[e.name] ?? {}`; secrets straight from `ctx.secrets`).

Behavior (spec §3.2): after the secrets loop and before settings, when `e.authorize`: if `connected()` →
`p.confirm("Sign in again?", false)`, else `p.confirm("Sign in now?", true)`. On yes, run `e.authorize.run(actx,
interactionFor(asking, openUrl, abort.signal))` where `asking` wraps `select/text/secret` so a `Cancelled` aborts the
controller and rethrows `Cancelled` (same pattern as `login` in `models-step.ts`). Success → `p.note(result)`,
`saved = true`. Other failure → `p.warn("Couldn't sign in: <message>")` then `p.confirm("Try signing in again?",
true)` loops. `isConfigured` also requires `await e.authorize.connected(...)` when present. `configurable` includes
any extension with `authorize`.

- [ ] **Step 1: Failing tests** in `test/configure.test.ts` with an inline extension object
  `{ name: "signin", summary: "S", secrets: [{ name: "signin.id", description: "Client id" }], authorize }` whose
  `run` calls `io.notify({ type: "auth_url", url: "https://example.test/auth" })`, then
  `await io.prompt({ type: "manual_code", message: "Paste the address" })`, stores it via `ctx.setSecret("signin.tok",
  value)` and returns `"Connected as a@b.c"`; `connected` = `!!(await ctx.secret("signin.tok"))`. Tests:
  - `configureExtension` with steps `[["Client id","id-1"],["Sign in now?",true],["Paste the address","code-1"]]`
    → returns true, `p.notes` includes `"https://example.test/auth"` and `"Connected as a@b.c"`, secret file
    `signin.tok` = `code-1`; `openUrl` spy called with the URL.
  - already connected: steps `[["Client id", ENTER], ["Sign in again?", false]]` → `run` not called.
  - `run` throwing `new Error("denied")` once: steps `…["Sign in now?",true],["Paste…","x"],["Try signing in
    again?",false]` → notes include `"Couldn't sign in: denied"`.
  - `"cancel"` answer at the paste prompt → `configureExtension` rejects with `Cancelled` and the `io.signal` passed
    to `run` is aborted.
  - `isConfigured` false until `signin.tok` exists, true after; `configurable([signin])` contains it even with no
    secrets declared.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Move the adapter, implement the above.
- [ ] **Step 4:** `npx vitest --run test/configure.test.ts test/setup-models.test.ts test/setup.test.ts` and typecheck pass.
- [ ] **Step 5:** Commit `feat(cli): japa setup signs in to extensions with an authorize hook`.

### Task 3: the `connect` tool (chat sign-in)

**Files:**
- Create: `src/kernel/authorize.ts`
- Modify: `src/kernel/secret-requests.ts` (add `removeSecretRequest`), `src/kernel/boot.ts` (wire tool, boot cleanup)
- Test: `test/authorize.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `export async function removeSecretRequest(tx: Tx, name: string): Promise<boolean>` in `secret-requests.ts`.
  - In `src/kernel/authorize.ts`:
    ```ts
    export type ConnectDeps = {
      extensions: () => JapaExtension[];
      context: (extension: string) => AuthorizeContext;
      /** Adds a pending secret request (`addSecretRequest`) and resolves with the value once fulfilled. */
      ask: (name: string, why: string) => Promise<string>;
      withdraw: (name: string) => Promise<void>; // removeSecretRequest on the root
      forget: (name: string) => Promise<void>;   // deletes the secret from the store
      report: (text: string) => Promise<void>;   // root.submit({ type: "input", content: text, requestId })
    };
    export function connectTool(deps: ConnectDeps): ToolRegistration; // name "connect"
    export const AUTHORIZE_SUFFIX = ".authorize";
    ```

Behavior (spec §3.3):
- Description: `Sign in to an extension that needs the user's account (e.g. "google"). Returns a link to send the
  user; you'll be told when sign-in finishes.` Parameters `{ extension: string }`.
- Unknown extension or one without `authorize` → reply `<name> has no sign-in.`
- Chat `AuthInteraction`: `notify` appends a line (`auth_url` → `Send the user this link to sign in: <url>` plus
  `instructions` if any; `info`/`progress` → their message). `prompt` of type `secret`/`manual_code` →
  `ask("<ext>.authorize", q.message)` raced with `q.signal` abort (on abort: `withdraw(name)` and reject); after a
  value arrives: `forget(name)` then return the trimmed value. `text`/`select` → reject `Error("This sign-in needs
  japa setup")`.
- The tool resolves when the flow first calls `prompt` or settles, with the collected lines, then
  `Waiting for the user to sign in.` (if still running) — or the outcome if settled.
- On settle: `report("[<ext>: <result>]")` or `report("[<ext>: couldn't connect: <message>]")`, with
  `requestId: "authorize:<ext>:<n>"`; the flow's own `AbortController` is aborted (withdrawing any prompt).
- While a flow for that extension runs, `connect` returns the lines collected so far plus `Already signing in.`
- Boot wiring: always install `connectTool` in the CoS kernel `tools` array in `boot.ts`. `context(ext)` is the
  extension's `kernel(ext)` (a `KernelContext` satisfies `AuthorizeContext`). `ask` uses `addSecretRequest` + the
  existing `provided(name)` waiters, bypassing the `declared` check for names ending in `.authorize` only. After
  `ensureRoot`, withdraw every pending request whose name ends with `.authorize` (stale from a previous run).
- Ruling recorded in plan: the spec says "installed when at least one loaded extension has authorize"; it is always
  installed instead, because `google` is packaged and the extension set changes at runtime. Update spec §3.3 to say so.

- [ ] **Step 1: Failing tests** in `test/authorize.test.ts`, booting with `bootTest({}, [probe.extension, fake])`
  where `fake` has `authorize.run` = notify `auth_url` `https://example.test/a`, then `await io.prompt({ type:
  "manual_code", message: "Paste the address", signal })`, return `"Connected as x"` (controllable via a deferred so
  the test can also make it resolve without a prompt):
  - `tool(daemon, faux, "connect", { extension: "fake" })` reply contains `Send the user this link to sign in:
    https://example.test/a` and `Waiting for the user to sign in.`; pending requests = `[{ name: "fake.authorize",
    why: "Paste the address" }]`.
  - fulfilling it via `surface().secrets.fulfil(id, " code ")` → `run` received `"code"`; secrets file
    `fake.authorize` does not exist afterwards; root user texts include `[fake: Connected as x]`.
  - flow whose prompt `signal` aborts (the fake's own controller wins) → pending becomes `[]`.
  - second `connect` while pending → reply contains `Already signing in.` and still one pending request.
  - `run` rejecting `new Error("denied")` → user texts include `[fake: couldn't connect: denied]`.
  - `connect({ extension: "web" })` → `web has no sign-in.`
  - boot over a home whose root already has a pending `fake.authorize` request (boot, add via
    `kernel.requestSecret` is not allowed — commit `addSecretRequest` through `daemon.root.commit`, close, reboot the
    same home with sqlite storage) → pending `[]` after boot. Use `storage: { adapter: "sqlite" }` for this test.
  - `removeSecretRequest` unit: removes by name, returns false when absent.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest --run test/authorize.test.ts test/secret-requests.test.ts` then full suite + typecheck.
- [ ] **Step 5:** Commit `feat(kernel): connect tool signs in to extensions from chat`; also edit the spec line.

### Task 4: Google sign-in and tokens

**Files:**
- Create: `extensions/google/auth.ts`
- Test: `test/google-auth.test.ts`

**Interfaces:**
- Consumes: Task 1 `AuthorizeContext`, pi-ai `AuthInteraction`.
- Produces:
  ```ts
  export const SECRETS = { clientId: "google.clientId", clientSecret: "google.clientSecret", token: "google.token" };
  export const SCOPES: string[]; // Global Constraints, in that order
  export type Endpoints = { authorize: string; token: string; userinfo: string };
  export const GOOGLE: Endpoints; // https://accounts.google.com/o/oauth2/v2/auth, https://oauth2.googleapis.com/token,
                                  // https://openidconnect.googleapis.com/v1/userinfo
  export type Token = { access_token: string; refresh_token: string; expires_at: number; scope: string;
                        email: string; expired?: boolean };
  export type Store = Pick<AuthorizeContext, "secret" | "setSecret">;
  export class NotSignedIn extends Error { constructor(readonly reason: "no_client" | "no_token" | "expired") }
  export function signIn(store: Store, io: AuthInteraction,
                         opts?: { endpoints?: Endpoints; timeoutMs?: number }): Promise<string>;
  export function isConnected(store: Store): Promise<boolean>;
  export function createTokens(store: Store, opts?: { endpoints?: Endpoints; now?: () => number }): {
    access(): Promise<string>;   // valid access token, refreshing if < 60 s left; throws NotSignedIn
    refresh(): Promise<string>;  // forced refresh (used after a 401)
  };
  export function statusLine(): string; // from a module-level cache of the last token read/written
  export function primeStatus(store: Store): Promise<void>; // reads client + token into the cache
  ```

Behavior: spec §4.2 steps 1–6, §4.3. Loopback: `http.createServer` on `127.0.0.1` port 0, redirect URI
`http://127.0.0.1:<port>/`; the callback page is plain HTML "Connected to Google. You can close this tab." or the
error; any request with a wrong `state` gets 400 and does not settle. Race with `io.prompt({ type: "manual_code",
message: "If the page didn't load after you approved, paste its full address here", signal })`; the loser is
aborted/closed. Pasted input: Review Focus #1. Token exchange: form-encoded POST `client_id, client_secret, code,
code_verifier, grant_type=authorization_code, redirect_uri`. Refresh: `grant_type=refresh_token`; response
`invalid_grant` → store token with `expired: true`, throw `NotSignedIn("expired")`. `statusLine()`:
`connected as <email>` | `not connected` | `sign-in expired — ask japa to reconnect`. `run` returns
`Connected as <email>`.

- [ ] **Step 1: Failing tests** against a local fake server (`node:http`) serving `/token` and `/userinfo`, passed
  as `endpoints`; a fake `io` whose `notify` captures the URL. Tests:
  - the authorize URL has `client_id`, `redirect_uri` = `http://127.0.0.1:<port>/`, `response_type=code`, `scope` =
    `SCOPES.join(" ")`, `code_challenge_method=S256`, `access_type=offline`, `prompt=consent`, and a `state`;
    `code_challenge` = base64url(sha256(verifier)) where the verifier is what `/token` received.
  - callback path: the test GETs `redirect_uri?code=c1&state=<state>` → `signIn` resolves `Connected as
    me@example.com`, the prompt's signal is aborted, `google.token` JSON has `refresh_token`, `email`, and
    `expires_at` = now + `expires_in`*1000.
  - wrong state on the callback → 400, flow keeps waiting; then a correct paste wins.
  - paste path: prompt answers `"  http://127.0.0.1:1/?code=c2&state=<state>  "` → resolves; the listener port is
    closed afterwards (connect refused).
  - `?error=access_denied` on callback → rejects with message containing `access_denied`.
  - paste `"not a url = x"` → rejects `That isn't the sign-in address`.
  - missing client secrets → rejects `needs google.clientId and google.clientSecret`.
  - token response without `refresh_token` → rejects mentioning `refresh token`.
  - `timeoutMs: 50` with no answer → rejects mentioning `timed out`.
  - `createTokens`: token with `expires_at` = now+30 s → three concurrent `access()` → one `/token` refresh, all get
    the new token; `invalid_grant` → throws `NotSignedIn("expired")`, stored token has `expired: true`,
    `statusLine()` = `sign-in expired — ask japa to reconnect`; no token → `NotSignedIn("no_token")`; no client →
    `NotSignedIn("no_client")`.
- [ ] **Step 2:** Run — FAIL.  **Step 3:** Implement.  **Step 4:** Pass + typecheck.
- [ ] **Step 5:** Commit `feat(google): sign-in with PKCE and a loopback redirect; token refresh`.

### Task 5: REST client, files, MIME

**Files:**
- Create: `extensions/google/api.ts`, `extensions/google/files.ts`, `extensions/google/mime.ts`
- Test: `test/google-api.test.ts`, `test/google-mime.test.ts`

**Interfaces:**
- Consumes: Task 4 `createTokens`, `NotSignedIn`.
- Produces:
  ```ts
  // api.ts
  export type Query = Record<string, string | number | boolean | string[] | undefined>;
  export class GoogleError extends Error {} // message is the user-facing reply
  export type Api = {
    json<T = any>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string,
                  opts?: { query?: Query; body?: unknown }): Promise<T>; // 204 → undefined
    bytes(url: string, query?: Query): Promise<{ data: Buffer; type: string }>;
    upload(url: string, metadata: object, data: Buffer, type: string, query?: Query): Promise<any>; // multipart/related
    raw(method: string, url: string, opts?: { query?: Query; body?: unknown }): Promise<{ status: number; body: string }>;
  };
  export function createApi(tokens: { access(): Promise<string>; refresh(): Promise<string> },
                            opts?: { sleep?: (ms: number) => Promise<void> }): Api;
  export const MAX = 50_000;
  export function truncate(text: string): string;
  /** Runs a handler and turns its text, a GoogleError, NotSignedIn or any error into a tool reply. */
  export function respond(run: () => Promise<string>): Promise<{ content: { type: "text"; text: string }[] }>;
  // files.ts
  export function saveFile(home: string, name: string, data: Buffer, date?: string): string; // returns the path
  export function readUpload(path: string): { name: string; type: string; data: Buffer };   // GoogleError if missing
  export function mimeType(name: string): string; // by extension; application/octet-stream default
  // mime.ts
  export type Mail = { to: string; cc?: string; bcc?: string; subject: string; body: string;
                       attachments?: { name: string; type: string; data: Buffer }[];
                       inReplyTo?: string; references?: string };
  export function buildMessage(mail: Mail, boundary?: string): string; // RFC 2822, CRLF
  export function base64url(data: string | Buffer): string;
  ```
- Query arrays repeat the key (`?id=a&id=b`); `undefined` values are dropped.
- Error replies (spec §5), exact text:
  - `NotSignedIn("no_client")` → `Google isn't set up: ask the user for google.clientId and google.clientSecret with
    secret_request (a Desktop app OAuth client; see japa's README), then connect({ extension: "google" }).`
  - `no_token` / `expired` → `Not signed in to Google (or the sign-in expired): call connect({ extension: "google" }).`
  - 401 → `refresh()` once and retry; a second 401 → the `expired` text.
  - 403 with reason `accessNotConfigured` or `SERVICE_DISABLED` → `The <API title or service> API isn't enabled
    for this Google project. Enable it at <activationUrl from error details, else https://console.cloud.google.com/apis/library>, then try again.`
  - 403 `insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` → `japa lacks access for this; reconnect to
    grant it: connect({ extension: "google" }).`
  - 404 → `Not found: <last path segment of the URL>`.
  - 429/5xx → one retry after `Retry-After` seconds (default 1, capped 10) via `sleep`; then
    `Google replied HTTP <status>: <error.message>`. Other 4xx → the same `Google replied …` line.
  - network → `Google request failed: <cause message>`.
- `raw` throws only for sign-in problems and network errors; HTTP statuses are returned.

- [ ] **Step 1: Failing tests.** `google-api.test.ts`: stub global `fetch` (`vi.stubGlobal`) with a fake `tokens`;
  assert bearer header, query encoding, JSON body + content type, 204 → undefined, each error mapping above (with
  `sleep` spy asserting 1000 / capped 10000), 401→refresh→retry success, `upload` body is `multipart/related` with
  the metadata JSON part then the data part, `saveFile` suffixing (`a.txt`, `a (1).txt`) under
  `<home>/attachments/google/2026-10-09/`, `truncate` at 50,000, `respond` mapping. `google-mime.test.ts`: plain
  message headers (`To`, `Subject`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=UTF-8`, base64 body),
  `Subject: Café` → `=?UTF-8?B?…?=`, attachments → `multipart/mixed; boundary="b"` with filename `"r.pdf"` and
  `filename*=UTF-8''r%C3%A9sum%C3%A9.pdf` for `résumé.pdf`, `In-Reply-To`/`References` emitted when set, bcc header
  present (Gmail strips it), CRLF line endings; `base64url` has no `+/=`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass + typecheck.
- [ ] **Step 5:** Commit `feat(google): authorized REST client, file saving and MIME messages`.

### Task 6: `gmail`

**Files:** Create `extensions/google/gmail.ts`; Test `test/google-gmail.test.ts`

**Interfaces:**
- Consumes: Task 5 `Api`, `GoogleError`, `saveFile`, `readUpload`, `buildMessage`, `base64url`; `htmlToText` from
  `../web/html.ts`.
- Produces: `export const GMAIL_ACTIONS = ["search","read","send","draft","modify","labels","attachment"] as const;`
  `export const gmailParameters` (TypeBox object), `export async function gmail(api: Api, home: string, args:
  GmailArgs): Promise<string>`, `export const GMAIL_DESCRIPTION: string` (one line per action, like browser's).

Base `https://gmail.googleapis.com/gmail/v1/users/me`. Behavior per spec §4.4 row `gmail`, plus:
- `search`: `GET messages?q&maxResults` then `GET messages/{id}?format=metadata&metadataHeaders=From,Subject,Date`
  for each; output lines `N. <Subject> — <From> — <Date>\n   <snippet>\n   id <id> thread <threadId>`; none → `No messages.`
- `read {id}`: `GET threads/{id}?format=full`; on `GoogleError` 404 try `GET messages/{id}?format=minimal` →
  its `threadId`. Each message: `From/To/Cc/Date/Subject`, `id`, body (Review Focus #4), `Attachments: <name>
  (<attachmentId>, <size> bytes)`.
- `send`/`draft`: `to`,`subject`,`body` required (missing → `send needs to, subject and body`). With `replyTo`:
  `GET messages/{replyTo}?format=metadata&metadataHeaders=Message-ID,References,Subject` → `inReplyTo`,
  `references` (existing + Message-ID), `threadId`, subject `Re: <orig>` when `subject` lacks `re:` (case-insensitive).
  send: `POST messages/send {raw, threadId?}` → `Sent (id <id>).` draft: `POST drafts {message: {raw, threadId?}}`
  → `Draft saved (id <id>).`
- `modify {ids, add?, remove?}`: names resolved via `GET labels` (case-insensitive name or id; unknown →
  `Unknown label: <x>`). `TRASH` in `add` → `POST messages/{id}/trash` for each id, then the rest via
  `POST messages/batchModify {ids, addLabelIds, removeLabelIds}`. Reply `Updated <n> message(s).`
- `labels`: `name (id)` per line. `attachment`: `GET messages/{m}/attachments/{a}` (base64url `data`), filename from
  the message part (`GET messages/{m}?format=full`) → `Saved to <path>`.

- [ ] **Step 1: Failing tests** with a fake `Api` (records `[method, url, opts]`, returns canned JSON by URL): one
  test per action asserting requests and the exact output text; the 404-fallback in `read`; nested multipart and
  HTML-only bodies; reply headers on `send` with `replyTo` (decode `raw` and check `In-Reply-To`, `References`,
  `Subject: Re: Lunch`, and `threadId`); unknown label; missing send fields; `gmailParameters` has no
  `schemaProblems`.
- [ ] **Step 2–4:** FAIL → implement → pass + typecheck.
- [ ] **Step 5:** Commit `feat(google): gmail tool`.

### Task 7: `drive`

**Files:** Create `extensions/google/drive.ts`; Test `test/google-drive.test.ts`

**Interfaces:** Consumes Task 5. Produces `DRIVE_ACTIONS` = `search, read, download, upload, create_folder, move,
rename, share, trash`; `driveParameters`; `drive(api, home, args): Promise<string>`; `DRIVE_DESCRIPTION`.

Base `https://www.googleapis.com/drive/v3/files`, upload `https://www.googleapis.com/upload/drive/v3/files`.
- `search`: if `query` contains any of ` contains `, `=`, ` in `, ` and `, ` or ` treat as Drive `q`, else
  `fullText contains '<escaped>'`; always `and trashed = false`; `fields=files(id,name,mimeType,modifiedTime,
  webViewLink)`, `pageSize=max`. Lines `N. <name> (<short type>) — modified <date>\n   id <id> <link>`.
- `read`: `GET files/{id}?fields=id,name,mimeType,size`; Docs (`application/vnd.google-apps.document`) →
  `GET files/{id}/export?mimeType=text/markdown` (bytes→utf8); Sheets → `text/csv`; Slides → `text/plain`; other
  `google-apps.*` → `Can't read <type>; use download.`; `text/*`, JSON, XML → `GET files/{id}?alt=media` as text;
  anything else → saved like `download`, reply `Not text; saved to <path>`.
- `download`: Google-type files export as PDF (`application/pdf`, name + `.pdf`); others `alt=media` → `Saved to <path>`.
- `upload {path, folder?, name?, convert?}`: `readUpload`; `convert` maps docx/txt/md→Doc, xlsx/csv→Sheet,
  pptx→Slides by setting metadata `mimeType`; `upload(..., query { uploadType: "multipart", fields:
  "id,name,webViewLink" })` → `Uploaded <name> (id <id>) <link>`.
- `create_folder` → `POST files` with folder mimeType; `move` → `GET ?fields=parents` then `PATCH ?addParents&removeParents`;
  `rename` → `PATCH {name}`; `share {id,email,role}` → `POST files/{id}/permissions {type:"user", role,
  emailAddress}` (`sendNotificationEmail` default); `trash` → `PATCH {trashed:true}`. Each replies one line naming
  the file id.

- [ ] Steps 1–5 as Task 6 (tests per action incl. query-detection both ways and the export mime per type).
  Commit `feat(google): drive tool`.

### Task 8: `calendar`

**Files:** Create `extensions/google/calendar.ts`; Test `test/google-calendar.test.ts`

**Interfaces:** Consumes Task 5. Produces `CALENDAR_ACTIONS` = `calendars, list, create, update, delete, freebusy`;
`calendarParameters`; `calendar(api, args, now?: () => Date): Promise<string>`; `CALENDAR_DESCRIPTION`.

Base `https://www.googleapis.com/calendar/v3`. `list`: `GET calendars/{cal}/events?timeMin&timeMax&q&singleEvents=
true&orderBy=startTime&maxResults=50`, default window now → now+7 d; the response `timeZone` formats times with
`Intl.DateTimeFormat("en-US", {timeZone, dateStyle:"medium", timeStyle:"short"})`; all-day events show the date and
`(all day)`. Lines `N. <summary> — <start> to <end>[ @ <location>]\n   id <id>[ attendees: a, b]`.
`create`/`update`: a `start`/`end` matching `^\d{4}-\d{2}-\d{2}$` → `{date}`, else `{dateTime}`; attendees →
`[{email}]`; update uses `PATCH` with only given fields. `delete` → `DELETE`. `freebusy` → `POST freeBusy {timeMin,
timeMax, items:[{id}...] }` (default `primary`), lines `<email>: busy <start>–<end>, …` or `free`.
`calendars` → `GET users/me/calendarList` lines `<summary> (<id>)[ primary]`.

- [ ] Steps 1–5 (tests: default window from injected `now`, timezone formatting, all-day, date vs dateTime,
  partial PATCH body, freebusy formatting). Commit `feat(google): calendar tool`.

### Task 9: `contacts` and `tasks`

**Files:** Create `extensions/google/contacts.ts`, `extensions/google/tasks.ts`; Test `test/google-contacts-tasks.test.ts`

**Interfaces:** Consumes Task 5. Produces `CONTACTS_ACTIONS` = `search, read, create, update`, `contactsParameters`,
`contacts(api, args)`, `CONTACTS_DESCRIPTION`; `TASKS_ACTIONS` = `lists, list, add, update, delete`,
`tasksParameters`, `tasks(api, args)`, `TASKS_DESCRIPTION`.

- contacts, base `https://people.googleapis.com/v1`, `FIELDS = "names,emailAddresses,phoneNumbers,organizations,
  biographies"`: `search` → `GET people:searchContacts?query&readMask=FIELDS` (Google requires a warm-up: when
  the first call returns no results, call once with `query=""` then retry once); `read {id}` (`people/…` or bare id
  → prefixed) → `GET people/{id}?personFields=FIELDS`; `create` → `POST people:createContact`; `update` → `GET` for
  `etag`, then `PATCH people/{id}:updateContact?updatePersonFields=<only changed>`. Lines `N. <name> — <emails> —
  <phones>\n   id people/<id>`.
- tasks, base `https://tasks.googleapis.com/tasks/v1`, default list `@default`: `lists` → `GET users/@me/lists`;
  `list` → `GET lists/{list}/tasks?showCompleted&showHidden=<showCompleted>`; `add` → `POST lists/{list}/tasks`
  (`due` date `YYYY-MM-DD` → `YYYY-MM-DDT00:00:00.000Z`); `update` → `PATCH` (`done: true` → `status:
  "completed"`, `false` → `needsAction` and `completed: null`); `delete` → `DELETE`. Lines `N. [x| ] <title>[ due
  <date>]\n   id <id>`.

- [ ] Steps 1–5 (include the warm-up retry and the etag round trip). Commit `feat(google): contacts and tasks tools`.

### Task 10: `google_request`, the manifest, and docs

**Files:**
- Create: `extensions/google/request.ts`, `extensions/google/index.ts`
- Modify: `test/configure.test.ts` (configurable list gains `google`), any test that enumerates packaged extensions,
  `README.md`, `docs/superpowers/specs/2026-10-07-japa-design.md`, `skills/building-extensions/SKILL.md`
- Test: `test/google.test.ts`

**Interfaces:** Consumes Tasks 1, 4–9.
- `request.ts`: `googleRequest(api, { method, url, query?, body? })`: URL must parse and its host end with
  `.googleapis.com` over `https:` else `Only https://*.googleapis.com URLs are allowed.`; reply `HTTP <status>\n<body>`.
- `index.ts`: `defineJapaExtension({ name: "google", summary: "Gmail, Drive, Calendar, Contacts and Tasks for one
  Google account", examples: [...3–4...], docs, provides: { tool: [gmail, drive, calendar, contacts, tasks,
  google_request] }, secrets: [{ name: "google.clientId", description: "Google OAuth client ID (a Desktop app
  client, see the README)" }, { name: "google.clientSecret", description: "Google OAuth client secret" }, { name:
  "google.token", description: "Google sign-in (made by connecting)", generated: true }], authorize: { run: (ctx,
  io) => signIn(ctx, io), connected: (ctx) => isConnected(ctx) }, setup: (ctx) => { keep ctx; void primeStatus(ctx) },
  status: statusLine })`. Each tool's `execute` = `respond(() => handler(api, ctx.home, args))` with one shared
  `createApi(createTokens(ctx))`. `docs` per spec §4.4 last paragraph (confirm before send/delete/trash/share;
  recovery steps).

- [ ] **Step 1: Failing tests** `test/google.test.ts`: `validateExtension(google)` = `[]`; every tool's parameters
  have no `schemaProblems`; booted daemon (`bootTest`) lists `google` with status `not connected`;
  `tool(daemon, faux, "gmail", { action: "labels" })` without secrets returns the `no_client` text; with client
  secrets but no token returns the `Not signed in…` text; `google_request` rejects `https://evil.example/x`; with a
  token secret written and `fetch` stubbed, `gmail labels` sends `Authorization: Bearer <token>` and formats.
  `japa check` path: `checkExtension`/equivalent used by `test/check.test.ts` passes for `google` (follow that file's
  pattern).
- [ ] **Step 2:** FAIL. **Step 3:** Implement; fix enumerating tests (e.g. configurable now
  `["brave","demo","google","parallel","telegram"]`).
- [ ] **Step 4:** Docs: README "Google" section (after Telegram/desktop sections: create a project; enable Gmail,
  Drive, Calendar, People, Tasks APIs; consent screen External+Testing with yourself as test user — sign-in expires
  every 7 days in Testing — or Internal on Workspace; OAuth client type Desktop app; then `japa setup` → google, or
  tell japa "connect my Google account"; what it can do). Main spec: remove "built-in OAuth flows" from non-goals,
  `authorize` in §5.1's manifest block, §9.5 withdrawal note, `google` row in §11.1. `building-extensions`: a short
  paragraph on `authorize` (`run(ctx, io)` / `connected(ctx)`, how setup and `connect` drive it).
- [ ] **Step 5:** Full suite + typecheck pass. Commit `feat(google): packaged google extension; docs`.
