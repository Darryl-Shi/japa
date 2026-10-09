# japa — Google: the `authorize` hook and the `google` extension

Date: 2026-10-09
Status: Draft for review
Extends: `2026-10-07-japa-design.md` (the "main spec")

## 1. Purpose

A chief of staff needs the user's mail, files, calendar, contacts and tasks. This spec adds:

1. An optional **`authorize` hook** in the extension manifest: an extension that signs in interactively (OAuth)
   declares it once, and the kernel runs it from **`japa setup`** (in the terminal) and from **chat** (through a new
   kernel tool `connect`, which works over `japa chat` and Telegram alike).
2. **`extensions/google`**, a packaged (default) extension: Gmail, Drive, Calendar, Contacts and Tasks, read and
   write, for one Google account, with the user's own OAuth client.

Success: the user creates a Google "Desktop app" OAuth client, gives japa its id and secret, signs in from `japa
setup` or by saying "connect my Google account" (from a phone over Telegram too), and can then ask the CoS to
search and answer mail, find and read Docs, schedule meetings, look up contacts and manage tasks.

### Changes to the main spec

- §1 Non-goals: remove "built-in OAuth flows".
- §5.1 Manifest: add `authorize` (§3 below).
- §9.5 Secret requests: the kernel may withdraw a pending request (§3.3).
- §11.1: add `google` to the default extensions: "tool — Gmail, Drive, Calendar, Contacts and Tasks for one Google
  account (`gmail`, `drive`, `calendar`, `contacts`, `tasks`, `google_request`). Dormant until the user provides
  `google.clientId`/`google.clientSecret` and signs in."

### Out of scope

Multiple Google accounts; a japa-owned (shipped, verified) OAuth client; user-configurable scopes; approval gates
for sending, deleting or sharing (still a main-spec non-goal); push notifications (Gmail watch, Calendar
webhooks) — they need an inbound endpoint; Google Workspace admin APIs; Photos, YouTube, Keep.

## 2. Constraints that shape the design

- **Scopes.** Gmail (`gmail.modify`) and full Drive (`drive`) are Google *restricted* scopes. A shared, shipped
  client would need Google verification and a yearly security assessment, so each user brings their own client
  (§4.1). An External app left in "Testing" status gets refresh tokens that expire after 7 days; a published app
  or a Workspace Internal app does not. japa surfaces expiry clearly (§4.3) and the README explains it.
- **Flow.** Google's device-code flow does not allow Gmail, full Drive or Calendar scopes, and the copy/paste
  out-of-band flow is gone. What remains for a "Desktop app" client is the authorization-code flow with PKCE and
  a loopback redirect (`http://127.0.0.1:<port>`). On a headless server the browser's final redirect fails to
  load; the user pastes that URL back, as pi's own provider sign-ins already do in `japa setup`.
- **No inbound port.** The loopback listener binds `127.0.0.1` only, on a random port, only for the length of one
  sign-in.

## 3. The `authorize` hook (kernel)

### 3.1 Manifest

```ts
/** What an authorize hook may use; `KernelContext` satisfies it, and so does setup (no daemon needed). */
export type AuthorizeContext = {
  home: string;
  settings(): JsonObject;
  secret(name: string): Promise<string | undefined>;
  setSecret(name: string, value: string): Promise<void>;
};

export type JapaExtension = {
  // ...existing fields
  authorize?: {
    /** Signs in through `io` and stores what it gets with `setSecret`; a short line for the user, e.g.
     *  "Connected as you@gmail.com". Throws with a user-facing message on failure. */
    run(ctx: AuthorizeContext, io: AuthInteraction): Promise<string>;
    /** Whether it's signed in now. */
    connected(ctx: AuthorizeContext): Promise<boolean>;
  };
};
```

`AuthInteraction`, `AuthPrompt` and `AuthEvent` are pi-ai's (`prompt(q)` returns the answer; `notify(event)` shows
an `auth_url`, `info` or `progress` event); `japa/sdk` re-exports them, with `AuthorizeContext`.
`validateExtension` checks that `authorize`, when present, has `run` and `connected` functions.

### 3.2 In `japa setup`

`configureExtension` asks for the extension's secrets as today, then, when it has `authorize`: if `connected()`,
asks "Sign in again?" (default No); otherwise "Sign in now?" (default Yes). A yes runs `run` through the existing
`interactionFor` adapter (`models-step.ts`, moved to a shared module), which prints the link, opens it when the
machine has a browser and lets the user paste into a `manual_code` prompt while the flow's own loopback listener
waits. The result line is shown with `note`; a failure with `warn`, and setup asks whether to try again.
Ctrl-C aborts the flow (its `signal`), as for provider sign-ins.

`isConfigured` additionally requires `connected()` for an extension with `authorize`, so the step lists it as
"(set up)" only once signed in. `configurable` includes every extension with `authorize`.

### 3.3 In chat: the `connect` tool

A kernel tool, always installed (the extension set changes at runtime); for an extension without `authorize` it
replies "<name> has no sign-in.":

```
connect({ extension }) — Sign in to an extension that needs the user's account (e.g. "google").
```

- It starts `run` in the background with a chat `AuthInteraction` and returns once the flow first waits for the
  user (a prompt) or ends. The tool result carries every `notify` event so far, as text for the CoS to pass on
  ("Send the user this link to sign in: …"), or the outcome if it already ended.
- A `prompt` of type `secret` or `manual_code` becomes a pending secret request named `<extension>.authorize`
  with the prompt's message as its `why`, so every surface asks for it masked (Telegram deletes the message).
  When fulfilled, the value is read from the secrets store, deleted from it at once, and returned to the flow;
  no `[secret … provided]` line goes to the CoS (the flow's outcome follows). `secret_request` refuses names
  ending in `.authorize`: only `connect` makes them.
  `text` and `select` prompts are not supported in chat: they fail the flow with "sign in from japa setup".
- When the prompt's `signal` aborts (e.g. the loopback callback won, or the flow ended), the request is withdrawn
  through a new `removeSecretRequest(name)` on the root's `SecretRequestsDoc`.
- When the flow ends, the kernel submits `[<extension>: <result line>]` or `[<extension>: couldn't connect:
  <message>]` to the root conversation, as `fulfilSecret` does.
- One flow per extension at a time: a second `connect` while one runs returns the pending link again. A pending
  flow is dropped when the daemon restarts (its request is withdrawn at boot); the user just connects again.
- The `<extension>.authorize` name is exempt from the "declared in `secrets`" check for this use only.

## 4. The `google` extension

`extensions/google/`: `index.ts` (manifest), `auth.ts`, `api.ts`, `mime.ts`, `gmail.ts`, `drive.ts`,
`calendar.ts`, `contacts.ts`, `tasks.ts`, `request.ts`. No new dependencies: REST over `fetch`.

### 4.1 Secrets and client setup

| Secret | Asked by setup | Content |
|---|---|---|
| `google.clientId` | yes | "Google OAuth client ID (a Desktop app client, see the README)" |
| `google.clientSecret` | yes | "Google OAuth client secret" |
| `google.token` | no (`generated`) | JSON `{ access_token, refresh_token, expires_at, scope, email }` |

The user creates the client in Google Cloud Console: a project, the Gmail, Drive, Calendar, People and Tasks
APIs enabled, an OAuth consent screen (External + Testing with themselves as a test user, or Internal on
Workspace), and an OAuth client of type "Desktop app". The README walks through it and links each console page.

### 4.2 Sign-in (`authorize.run`)

Scopes (fixed): `openid email https://www.googleapis.com/auth/{gmail.modify,drive,calendar,contacts,tasks}`.

1. Fail with "needs google.clientId and google.clientSecret" if either is missing.
2. Make a PKCE verifier/challenge (S256) and a random `state`; listen on `127.0.0.1:0`, path `/`.
3. `notify({ type: "auth_url", url, instructions })` with `https://accounts.google.com/o/oauth2/v2/auth?
   client_id, redirect_uri=http://127.0.0.1:<port>/, response_type=code, scope, state, code_challenge,
   code_challenge_method=S256, access_type=offline, prompt=consent`. The instructions say that if the page fails to
   load after approving, copy its full address and paste it here.
4. Race the listener's callback against `prompt({ type: "manual_code", signal })`; the winner aborts the other.
   A pasted value is parsed as a URL (its `code`, `state`, `error`). Check `state`; an `error` parameter (e.g.
   `access_denied`) fails with Google's reason. The listener answers the browser with a short "Connected, you can
   close this tab" page (or the error).
5. Exchange the code at `https://oauth2.googleapis.com/token` (with the verifier and redirect URI), read the email
   from `https://openidconnect.googleapis.com/v1/userinfo`, store `google.token`, close the listener, return
   "Connected as <email>". A missing `refresh_token` in the response fails with a clear message (it should not
   happen with `prompt=consent`).
6. Give up after 10 minutes.

`authorize.connected` is true when `google.token` exists and is not marked expired.

### 4.3 Access tokens and status

`api.ts` holds `accessToken()`: the stored token if it expires more than 60 s from now; otherwise a refresh
(`grant_type=refresh_token`), with one refresh in flight at a time, storing the new access token and expiry.
A refresh answered `invalid_grant` marks the stored token `expired: true` (keeping the email for the status line).

`gfetch(method, url, { query, body, raw })` adds the bearer token and maps failures to the user-facing replies of
§5. Every tool goes through it.

`status()`: `connected as x@gmail.com`, `not connected` (no client or no token), or `sign-in expired — ask japa to
reconnect`. It's computed from a cached copy of the token updated on each read and write, as `status` is synchronous.

### 4.4 Tools

Each tool takes an `action` and that action's fields, like `browser`. Output is plain text; lists are numbered and
carry the ids the next call needs; output is truncated at 50,000 characters (as `web_fetch`). Times are shown in
the calendar's time zone.

| Tool | Actions |
|---|---|
| `gmail` | `search {query, max?=10}` (Gmail search syntax; from, subject, date, snippet, message and thread ids) · `read {id}` (a thread as text: headers, plain-text body or HTML converted to text, attachment names and ids) · `send {to, cc?, bcc?, subject, body, attachments?, replyTo?}` · `draft {…as send}` · `modify {ids, add?, remove?}` (label names or ids; archive = remove `INBOX`; `TRASH` to trash) · `labels` · `attachment {messageId, attachmentId}` (saved to a file) |
| `drive` | `search {query, max?=10}` (plain words become a `fullText contains` query; Drive `q` syntax passes through) · `read {id}` (Docs exported as markdown, Sheets as CSV (first sheet), Slides as plain text, text files raw, anything else saved to a file) · `download {id}` · `upload {path, folder?, name?, convert?}` · `create_folder {name, folder?}` · `move {id, folder}` · `rename {id, name}` · `share {id, email, role}` (`reader`/`commenter`/`writer`) · `trash {id}` |
| `calendar` | `calendars` · `list {from?, to?, calendar?="primary", query?}` (default: the next 7 days) · `create {summary, start, end, attendees?, location?, description?, calendar?}` (dates for all-day events, RFC 3339 times otherwise) · `update {id, calendar?, …fields to change}` · `delete {id, calendar?}` · `freebusy {from, to, emails?}` (a bare date in `from`/`to` is local midnight: in `timeZone` if given, else the calendar's zone) |
| `contacts` | `search {query}` · `read {id}` · `create {name, emails?, phones?, notes?}` · `update {id, …}` |
| `tasks` | `lists` · `list {list?, showCompleted?}` · `add {title, notes?, due?, list?}` · `update {id, list?, title?, notes?, due?, done?}` · `delete {id, list?}` |
| `google_request` | `{method, url, query?, body?}`: any Google REST call the others don't cover. The URL must be `https://*.googleapis.com/…`; returns the status and the JSON body, truncated. |

`send` and `draft` build an RFC 2822 message in `mime.ts`: UTF-8 headers encoded per RFC 2047, a `text/plain` body,
`multipart/mixed` when there are attachments (host paths, content type by extension), sent through Gmail's media
upload endpoints (`message/rfc822`; a JSON `raw` is capped near 1 MB).
`replyTo` (a message id) sets `threadId`, `In-Reply-To` and `References` from that message, and `Re: ` on the subject
when missing.

**Files.** Downloads and attachments go to `<home>/attachments/google/<YYYY-MM-DD>/<name>` (a numeric suffix
avoids clobbering), and the tool returns the path. `attachments/` is already git-ignored and mounted read-only in
the desktop container. `upload` and `send` take paths on the japa host.

**Docs for the CoS** (the manifest's `docs`) list each tool's actions in one line each, say that sending,
deleting, trashing and sharing should be confirmed with the user unless they asked for that exact action, and how
to recover: missing client → `secret_request` for `google.clientId`/`google.clientSecret`; not connected or
expired → `connect({ extension: "google" })`.

## 5. Error handling

Tools never throw to the CoS; each returns a short reason:

- No client secrets: "Google isn't set up: ask the user for google.clientId and google.clientSecret with
  secret_request (a Desktop app OAuth client; see japa's README), then connect({ extension: "google" })."
- No token, or expired: "Not signed in to Google (or the sign-in expired): call connect({ extension: "google" })."
- 401 after a successful refresh: refresh once more, then as expired.
- 403 `accessNotConfigured` / `SERVICE_DISABLED`: names the API and links the console page that enables it.
- 403 insufficient scopes: "japa lacks access for this; reconnect to grant it."
- 404: "Not found: <id>".
- 429 and 5xx: one retry after 1 s (or `Retry-After`, capped at 10 s), then "Google replied HTTP <status>:
  <message>".
- Network errors: the `cause` message (as `parallel`).
- Local files: a missing upload/attachment path names the path.

Sign-in failures (denied consent, state mismatch, failed exchange, timeout) are thrown by `run` with a user-facing
message: setup warns and offers a retry; chat reports `[google: couldn't connect: …]`.

## 6. Testing

vitest, no calls to Google.

- **Kernel**: `validateExtension` accepts a valid `authorize` and rejects a malformed one. Setup with a scripted
  Prompter runs `run` after the secrets, and `isConfigured` follows `connected()`. The `connect` tool with the faux
  kit returns the notified link; a `manual_code` prompt becomes a `<ext>.authorize` secret request; fulfilling it
  resumes the flow, deletes the stored value and submits the result line to the root; an aborted prompt withdraws
  the request; a second `connect` while pending returns the same link; boot withdraws a stale `.authorize` request.
- **Google auth** (endpoints injectable, against a local fake token/userinfo server): PKCE and state are sent and
  checked; the loopback callback wins over a pending paste, and a pasted URL wins over a silent listener; `error`
  in the redirect fails with the reason; refresh happens near expiry, once under concurrent callers; `invalid_grant`
  marks the token expired and the status says so.
- **Tools** (fake `fetch` recording requests, canned responses): each action's request (method, URL, query,
  body) and formatted output; truncation; the error mapping of §5; download paths and suffixing.
- **MIME**: headers and RFC 2047 subjects, multipart with attachments, reply headers and `Re:`.
- **Load**: the packaged extension loads with the others and passes `japa check extension google`.

## 7. Docs

- README: a "Google" section — creating the client (projects, enabling the five APIs, consent screen and the 7-day
  Testing caveat, Desktop app client), then connecting from `japa setup` or by asking japa; what the CoS can do.
- Main spec changes as in §1. `skills/building-extensions`: a paragraph on `authorize` for extensions that sign in.
