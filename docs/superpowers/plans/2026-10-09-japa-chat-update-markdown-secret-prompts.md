# Secret prompts, chat markdown and /update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secret requests get their own reply-to prompts (with Decline) on every messaging adapter, Telegram renders
markdown through a real parser, and the owner can update and roll back japa from chat with `/update`.

**Architecture:** Part A changes the messaging contract (`OutgoingMessage.input`, `Incoming.replyTo`,
`secrets.decline`) and replaces the surface's "next text is the secret" logic with saved prompts per request. Part B
rewrites `extensions/telegram/html.ts` on `marked`'s lexer. Part C adds a kernel-side update state file and an
`Updater` the CLI injects into `boot`; the chat menu checks, launches a detached `japa update --from-chat`, and the
surface reports the result from whichever daemon is alive.

**Tech Stack:** TypeScript on Node 24 (type stripping), vitest, `@earendil-works/pi-durable`, `marked` 18.0.11.

**Spec:** `docs/superpowers/specs/2026-10-09-japa-chat-update-markdown-secret-prompts-design.md`

## Global Constraints

- Node ≥ 24; source runs with type stripping (no enums, no parameter properties, `.ts` import suffixes).
- `marked` pinned to exactly `18.0.11` (the version `@earendil-works/pi-tui` already installs); no other new deps.
- Telegram: callback `action` ≤ 64 bytes; `input_field_placeholder` ≤ 64 characters (truncate with `…`); message text
  limit 4096 visible characters.
- Prompt copy: `` japa needs `<name>`: <why>. Reply to this message with it; I'll delete your reply at once. ``;
  placeholder `Paste <name>`; decline message `` Don't want to provide `<name>`? `` with one button `Decline`.
- CoS notes: `[secret <name> provided]` (unchanged), `[secret <name> declined]` with requestId `secret-declined:<id>`.
- Stale reply notice: `That request is no longer pending.`; prompt history keeps the last 50 prompt ids per adapter.
- Update state file `<home>/update.json` (atomic write: temp + rename); log `<home>/logs/update.log`.
- A `running` update state without a pid for 60 s, or with a dead pid, is interrupted. Reports are polled every 2 s.
- `/update` lists the newest 20 commits, then `+M more`.
- Run tests with `npx vitest --run <file> [-t <name>]`; typecheck with `npm run typecheck`. Both must pass at the
  end of every task.
- Docs and code comments follow the repo's style: plain sentences, behaviour described in doc comments.

## Review Focus

1. **Double tap on Update now** (or two `/update` screens): the second start must answer
   `An update is already running (started <1m ago).` and launch nothing — test in Task 8.
2. **A reply to a prompt that carries no text** (a photo, a sticker): never fulfils, never reaches the CoS; the owner
   is told `Reply with the secret as text.` — test in Task 2.
3. **A prompt whose send fails** (bot blocked, network): nothing is saved, so the next sync tries again, and a later
   success sends exactly one prompt — test in Task 2.
4. **A missing or corrupt `update.json`** (hand-edited, half-written by an old version): treated as no update;
   `/update` still works and nothing is reported — test in Task 6.
5. **Markdown that never closes** (an unterminated ```` ``` ```` fence, a lone `**`): renders valid HTML that
   Telegram accepts, with the text intact — test in Task 5.

---

## Part A — secret prompts

### Task 1: Contract and kernel: `input`, `replyTo`, `secrets.decline`

**Files:**
- Modify: `src/kernel/contracts.ts` (`Incoming`, `OutgoingMessage`, `SurfaceContext.secrets`)
- Modify: `src/kernel/secret-requests.ts` (new `declineSecret`, `DECLINED_PREFIX`)
- Modify: `src/kernel/boot.ts:~244-300` (waiters, `fulfil`, connect's `ask`, `surface.secrets`)
- Test: `test/secret-requests.test.ts`

**Interfaces:**
- Produces:
  - `Incoming.replyTo?: string` — id of the message replied to.
  - `OutgoingMessage.input?: { placeholder: string }` — show with the platform's reply input.
  - `SurfaceContext.secrets.decline(requestId: string): Promise<void>` — throws `No pending request <id>` for an
    unknown one.
  - `declineSecret(harness: Harness, root: Conversation, requestId: string, context: Context): Promise<SecretRequest>`
    in `secret-requests.ts`: removes the request; for a non-`.authorize` name submits
    `{ type: "input", content: "[secret <name> declined]", requestId: "secret-declined:<id>" }`; returns the request.

- [ ] **Step 1: Write the failing tests** in `test/secret-requests.test.ts`

```ts
test("declining a request removes it and tells the CoS once, without a value", async () => {
  // boot with probe(); CoS calls secret_request svc.token on "go"
  await surface().secrets.decline(pending[0]!.id);
  expect(snapshot().pending).toEqual([]);
  await waitFor(async () => (await texts(daemon.root, "user")).includes("[secret svc.token declined]"));
  await expect(surface().secrets.decline(pending[0]!.id)).rejects.toThrow(`No pending request ${pending[0]!.id}`);
  expect((await texts(daemon.root, "user")).filter((t) => t === "[secret svc.token declined]")).toHaveLength(1);
});

test("declining a sign-in's request ends connect with the decline, not a CoS note", async () => {
  // an extension with an `authorize` whose prompt is a `secret`; CoS calls connect
  await surface().secrets.decline(idOf("demo.authorize"));
  await waitFor(async () => (await texts(daemon.root, "user")).includes("[demo: couldn't connect: The sign-in was declined]"));
  expect(await texts(daemon.root, "user")).not.toContain("[secret demo.authorize declined]");
});

test("a requestSecret waiter keeps waiting after a decline and resolves on the next value", async () => {
  const value = kernel().requestSecret("demo.key", "to ping");
  await surface().secrets.decline(idOf("demo.key"));
  let settled = false; void value.then(() => (settled = true));
  await sleep(200); expect(settled).toBe(false);
  // the CoS asks again; fulfil
  expect(await value).toBe("v");
});
```

Use the file's existing helpers (`probe`, `script`, `call`, `texts`) and the authorize fixture pattern from
`test/authorize.test.ts`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest --run test/secret-requests.test.ts -t "declin"`
Expected: FAIL — `decline is not a function`.

- [ ] **Step 3: Implement**

  - Add the three contract fields with doc comments.
  - `declineSecret` beside `fulfilSecret`, same shape (snapshot, find, commit removal, submit).
  - In `boot.ts`, waiters become `{ resolve, reject?: (e: Error) => void }`; `provided(name, rejectable = false)`.
    connect's `ask` uses `provided(name, true)`; `requestSecret`/`secretProvided` stay non-rejectable.
  - `decline = async (id) => { const r = await declineSecret(...); if (r.name.endsWith(AUTHORIZE_SUFFIX))
    rejectWaiters(r.name, new Error("The sign-in was declined")); }` — `rejectWaiters` rejects only rejectable
    waiters and keeps the rest. Expose as `surface.secrets.decline`.

- [ ] **Step 4: Run the tests** — `npx vitest --run test/secret-requests.test.ts test/authorize.test.ts` → PASS;
  `npm run typecheck` → PASS (the fake adapter and gateway compile unchanged: fields are optional).

- [ ] **Step 5: Commit** — `git commit -m "feat(secrets): decline a pending request; reply-input and replyTo in the messaging contract"`

### Task 2: Surface: a prompt per request, answered by reply

**Files:**
- Modify: `src/kernel/messaging/surface.ts` (remove `awaiting`/`announce`/held interplay; add prompts)
- Modify: `src/kernel/contracts.ts` (`MessagingContext` prompt state)
- Modify: `src/kernel/boot.ts` (`messaging.promptState` / `savePromptState`)
- Modify: `src/kernel/messaging/menu/index.ts` (nothing announces any more; `UNDELETED` stays)
- Test: `test/messaging.test.ts` (rewrite the block at lines 257–332), `test/messaging-menu.test.ts` (rewrite the
  tests at ~896–1036 and the "secret prompt open when the daemon stopped" `PROMPT` expectations at ~1174–1210)

**Interfaces:**
- Consumes: Task 1's `replyTo`, `input`, `secrets.decline`.
- Produces:
  - `type SecretPrompt = { requestId: string; chat: string; prompt: string; decline: string }` (exported from
    `surface.ts`).
  - `MessagingDoc` value gains optional `prompts?: Record<string, SecretPrompt[]>` and
    `promptHistory?: Record<string, string[]>` (no version bump: both optional).
  - `MessagingContext.promptState(adapter: string): Promise<{ prompts: SecretPrompt[]; history: string[] }>` and
    `MessagingContext.savePromptState(adapter: string, state: { prompts: SecretPrompt[]; history: string[] }): Promise<void>`
    (history trimmed to the last 50 by `savePromptState`).
  - Decline buttons' action: `d:<requestId>` (handled by the surface, never the menu).

Behaviour (spec §2.4–2.5), as one serialized `sync()` run on the surface's `handled` queue whenever the pending list
changes and before handling each owner message:
1. For each saved prompt whose request is no longer pending: delete both messages (errors ignored), drop the entry.
2. With an owner, for each pending request without a prompt: send the prompt (`input: { placeholder }`), then the
   decline message (`buttons: [[{ label: "Decline", action: "d:<id>" }]]`), then save both ids. A failed send saves
   nothing (and deletes a prompt already sent), so the next `sync` retries.

In `route`, before the menu-input branch: an owner message with `replyTo` matching a saved prompt → if it has no
text, send `Reply with the secret as text.`; else fulfil (`secrets.fulfil(requestId, text, "<adapter>:<id>")`),
delete the reply (`UNDELETED` notice on failure), delete prompt and decline message, drop the entry. A `replyTo` in
history but not in prompts → delete it, `recordSecretMessage`, send `That request is no longer pending.`; never
submitted. An action `d:<id>` → `secrets.decline(id)`; an unknown id just deletes the press's message and its prompt
if known.

- [ ] **Step 1: Write the failing tests** in `test/messaging.test.ts`, replacing the old secret block

```ts
const PROMPT = "japa needs `svc.token`: to sync. Reply to this message with it; I'll delete your reply at once.";
const DECLINE = "Don't want to provide `svc.token`?";
/** Boots, has the CoS ask for svc.token on "connect", waits for prompt + decline; their sent records. */
async function prompted(fake, extra = []) { /* … */ return { ...booted, prompt, decline }; }

test("each pending request gets a reply prompt with a placeholder, then a Decline message", …
  // expect(prompt).toMatchObject({ markdown: PROMPT, input: { placeholder: "Paste svc.token" } })
  // expect(decline).toMatchObject({ markdown: DECLINE, buttons: [[{ label: "Decline" }]] })
test("a reply to the prompt fulfils it; reply, prompt and decline message are deleted", …
  // receive({ text: "s3cr3t", messageId: "77", replyTo: prompt.id }) → secrets/svc.token is "s3cr3t";
  // deleted ⊇ [77, prompt.id, decline.id]; "[secret svc.token provided]"; transcript never contains "s3cr3t"
test("a plain text while a request is pending goes to the CoS and leaves the request", …
test("three requests are prompted at once and answered in any order", …
test("prompts survive a restart: none is sent again and a reply still fulfils", … // sqlite storage, as menu tests do
test("Decline withdraws the request, tells the CoS, and deletes both messages", …
test("a request fulfilled in japa chat deletes its prompt", … // probe().secrets.fulfil
test("a reply to a prompt no longer pending is deleted, never submitted, and the owner told", …
  // fulfil via probe first, then reply to the old prompt id → "That request is no longer pending."
test("a reply to a prompt without text asks for text and fulfils nothing", … // images only
test("a reply delivered again is dropped and deleted again", …
test("if the reply can't be deleted, the secret is still stored and the owner told", …
test("without an owner nothing is prompted; the owner's first message brings the prompts", …
test("a prompt whose send fails is retried on the next sync and sent once", …
  // fake.failSend = (m) => m.input !== undefined; add request; then clear failSend and receive a text
  // → exactly one sent with markdown PROMPT
```

In `test/messaging-menu.test.ts`, replace the "held back" tests with:

```ts
test("a request is prompted even while a menu input waits; a reply fulfils it and plain text goes to the input", …
test("a secret prompt open when the daemon stopped holds a plain text, not a reply to a request prompt", …
  // askThenRestart(add svc.token); the prompt IS sent at boot; a reply to it fulfils svc.token;
  // a plain text gets EXPIRED and is deleted, as before
```

Update `fakeAdapter` in `test/messaging-helpers.ts` so `sent`/`edited` records keep `input`, and `press` also
accepts a sent message id: `press(label, id?)`.

- [ ] **Step 2: Run to see them fail** — `npx vitest --run test/messaging.test.ts test/messaging-menu.test.ts`
  Expected: the new tests FAIL (prompt text differs, no `input`).

- [ ] **Step 3: Implement** per the behaviour above. Keep the surface's doc comment in step with the new behaviour.

- [ ] **Step 4: Run** — `npx vitest --run test/messaging.test.ts test/messaging-menu.test.ts test/secret-requests.test.ts`
  → PASS; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(messaging): a reply prompt per secret request, with Decline"`

### Task 3: Telegram: force-reply prompts and `replyTo`

**Files:**
- Modify: `extensions/telegram/index.ts` (`post`)
- Modify: `extensions/telegram/updates.ts` (`Update.message.reply_to_message`, `parseUpdate`)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `OutgoingMessage.input`, `Incoming.replyTo` (Task 1).

- [ ] **Step 1: Write the failing tests**

```ts
test("a message with input is sent with force_reply and a placeholder cut to 64 characters", async () => {
  const adapter = await connect();
  await adapter.send("42", { markdown: "x", input: { placeholder: `Paste ${"k".repeat(70)}` } });
  const markup = sends()[0].reply_markup;
  expect(markup.force_reply).toBe(true);
  expect([...markup.input_field_placeholder]).toHaveLength(64);
  expect(markup.input_field_placeholder.endsWith("…")).toBe(true);
});
test("input together with buttons is rejected before sending", … // rejects.toThrow("input and buttons"); sends() empty
test("a reply carries the id of the message it replies to", …
  // fake.push(text(100, "s", { reply_to_message: { message_id: 7 } })) → received[0].replyTo === "7"
```

- [ ] **Step 2: Run** — `npx vitest --run test/telegram.test.ts -t "input|replies to"` → FAIL.
- [ ] **Step 3: Implement** — in `post`, `reply_markup` is `{ force_reply: true, input_field_placeholder }` when
  `m.input` is set; throw `Error("A message can't have both input and buttons")` when both are. `parseUpdate` sets
  `replyTo: String(reply_to_message.message_id)` when present (texts and images).
- [ ] **Step 4: Run** — `npx vitest --run test/telegram.test.ts` → PASS; typecheck PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): reply prompts with a placeholder; replies carry replyTo"`

### Task 4: `japa chat`: Ctrl-X declines

**Files:**
- Modify: `extensions/gateway/protocol.ts` (`ClientMessage` gains `{ type: "decline"; requestId: string }`)
- Modify: `extensions/gateway/index.ts` (case `"decline"` → `ctx.secrets.decline`)
- Modify: `extensions/gateway/chat.ts` (Ctrl-X while a prompt shows sends `decline`; prompt text gains
  `(Esc hides, Ctrl-X declines)`)
- Test: `test/gateway.test.ts`

- [ ] **Step 1: Write the failing test** — `test("a decline message withdraws the request and tells the CoS", …)`:
  attach, wait for the `secrets` list, `client.send({ type: "decline", requestId })`, then a later `secrets` message
  has `pending: []` and the root has `[secret svc.token declined]`.
- [ ] **Step 2: Run** — `npx vitest --run test/gateway.test.ts -t decline` → FAIL ("Invalid message").
- [ ] **Step 3: Implement** the three changes (a non-string `requestId` answers `Invalid message`).
- [ ] **Step 4: Run** — `npx vitest --run test/gateway.test.ts` → PASS; typecheck PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(gateway): Ctrl-X declines a secret request"`

## Part B — markdown

### Task 5: `toHtml` on marked, plain fallback, overflow split

**Files:**
- Modify: `package.json`, `package-lock.json` (`"marked": "18.0.11"` in dependencies; `npm install --save-exact marked@18.0.11`)
- Rewrite: `extensions/telegram/html.ts`
- Modify: `extensions/telegram/index.ts` (`post` fallback; `send` overflow)
- Modify: `src/kernel/identity.md` (one line)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Produces (in `html.ts`): `toHtml(markdown: string): string`, `toPlain(markdown: string): string`,
  `visibleLength(html: string): number` (characters after removing tags and decoding `&amp; &lt; &gt; &quot;`).

Rendering table: spec §3.1, exactly. Notes the tests and signature don't settle:
- Use `new Marked({ gfm: true })` with one inline extension `spoiler` (`||text||` → `<tg-spoiler>`).
- Tags are emitted from a recursive token walk (`strong`→`b`, `em`→`i`, `del`→`s`), so nesting follows the token
  tree. Block tokens join with `\n\n`; list items with `\n`.
- Table: each column's width is its longest plain-text cell (header included); a row is its cells padded right to
  those widths, joined with ` | `, trailing spaces trimmed; under the header a `─` rule as long as the widest padded
  line; all escaped inside one `<pre>`.

- [ ] **Step 1: Write the failing tests** — keep the existing `test.each` rows; add:

```ts
["***both***", "<b><i>both</i></b>"],
["**bold _nested_ here**", "<b>bold <i>nested</i> here</b>"],
["a **lone star", "a **lone star"],
["```\nunclosed", "<pre>unclosed</pre>"],
["- a\n  - b\n- c", "• a\n  • b\n• c"],
["1. a\n2. b", "1. a\n2. b"],
["- [ ] todo\n- [x] done", "☐ todo\n☑ done"],
["| a | bb |\n|---|---|\n| 1 | <2> |", "<pre>a | bb\n───────\n1 | &lt;2&gt;</pre>"],
["<script>x</script>", "&lt;script&gt;x&lt;/script&gt;"],
["||secret||", "<tg-spoiler>secret</tg-spoiler>"],
["![cat](https://e.com/c.png)", '<a href="https://e.com/c.png">cat</a>'],
["---", "———"],
```

plus:

```ts
test("a blockquote over 10 lines is expandable", () =>
  expect(toHtml(Array.from({ length: 11 }, (_, i) => `> ${i}`).join("\n"))).toMatch(/^<blockquote expandable>/));
test("toPlain drops markers and keeps link targets", () =>
  expect(toPlain("**a** [b](https://e.com) `c`")).toBe("a b (https://e.com) c"));
test("HTML Telegram can't parse is resent as plain text without markers", …
  // replaces the old raw-markdown expectation: sends().at(-1) toEqual({ chat_id: "42", text: "hi" })
test("a part whose rendered text is over 4096 characters is sent as two messages", …
  // a 60-row table of ~70 chars per row: two sendMessage calls, each visibleLength ≤ 4096; send returns the last id
```

Every `toHtml` output must also be accepted by a strict tag-balance check you add as a helper (`balanced(html)`: every opened tag closes in LIFO order) and run over
all `test.each` rows.

- [ ] **Step 2: Run** — `npx vitest --run test/telegram.test.ts` → the new rows FAIL.
- [ ] **Step 3: Implement** `html.ts`; in `index.ts`, the 400 fallback sends `toPlain(m.markdown)`; `send` splits
  with `splitMessage` (export it from `src/sdk.ts`) at half the markdown length while `visibleLength(toHtml(part))`
  exceeds 4096, sending parts in order and returning the last id. Add to `identity.md`: "Your replies render as
  Markdown in chats; tables show as monospace, so keep them narrow."
- [ ] **Step 4: Run** — `npx vitest --run test/telegram.test.ts test/split.test.ts` → PASS; typecheck PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(telegram): markdown through marked: nesting, lists, tables, spoilers; plain fallback"`

## Part C — /update

### Task 6: Update state file and `japa update --from-chat`

**Files:**
- Create: `src/kernel/update-state.ts`
- Modify: `src/cli/update.ts` (`checkForUpdate`, `UpdateOptions.record`, `whatsNew`/`restart` return values,
  `--from-chat`)
- Test: `test/update.test.ts`, new `test/update-state.test.ts`

**Interfaces:**
- Produces (`src/kernel/update-state.ts`):

```ts
export type UpdateState = {
  state: "running" | "updated" | "up to date" | "failed";
  pid?: number; started: number; finished?: number;
  chat: { adapter: string; chat: string };
  from: string; to?: string;
  rollback: boolean;
  restarted?: Restarted;
  summary?: string; output?: string;
  commits?: string[]; whatsNew?: string[];
  reported: boolean;
};
export type Restarted = "service" | "foreground" | "stopped" | "none";
export type UpdateCheck = { current: string; target: string; commits: string[] }; // full shas; "abc1234 subject", newest first
export type Updater = {
  check(): Promise<UpdateCheck>;
  launch(to: string): Promise<void>; // starts `japa update --to <to> --from-chat` detached
};
export const updateFile: (home: string) => string;       // <home>/update.json
export const updateLog: (home: string) => string;        // <home>/logs/update.log
export function readUpdateState(home: string): UpdateState | undefined; // missing or unparsable → undefined
export function writeUpdateState(home: string, state: UpdateState): void; // atomic
export function patchUpdateState(home: string, patch: Partial<UpdateState>): void; // no file → no-op
/** "running", "interrupted" (dead pid, or no pid after 60 s) or "finished". */
export function liveness(state: UpdateState, now: number, alive?: (pid: number) => boolean): "running" | "interrupted" | "finished";
```

- Produces (`src/cli/update.ts`):
  - `checkForUpdate(app: string, branch?: string): Promise<UpdateCheck>` (fetch, resolve `origin/<branch>`, commits
    `rev-list` newest first as `log --oneline`); `--check` uses it; throws `UpdateFailed` as `update` does.
  - `UpdateOptions.record?: (patch: Partial<UpdateState>) => void`.
  - `UpdateDeps.whatsNew(...)` returns `Promise<string[]>`: interactive → `stdio: "inherit"`, `[]`; otherwise the
    output's non-empty lines, each also passed to `o.log`.
  - `UpdateDeps.restart(log)` and `restartAfterUpdate(...)` return `Promise<Restarted>`: `"service"` when restarted,
    `"foreground"`, `"stopped"` (inactive), `"none"` (not installed); `update` uses `"none"` with `--no-restart`.
  - `updateCommand` handles `--from-chat`: `record = (p) => patchUpdateState(home, p)`, and `interactive: false`.

`record` calls: first thing `{ pid: process.pid }`; up to date `{ state: "up to date", to: old, finished }`; any
`UpdateFailed` or other error `{ state: "failed", summary: <first line>, output: <rest or undefined>, finished }`;
success, after the restart, `{ state: "updated", to: target, commits: <newest 20 oneline>, whatsNew, restarted,
finished }`.

- [ ] **Step 1: Write the failing tests**

`test/update-state.test.ts`:
```ts
test("a missing, empty or corrupt update.json reads as undefined", …) // "", "{", "[]", '{"state":1}'
test("write then read round-trips, via a temp file in the same directory", …)
test("patch merges into the file and does nothing without one", …)
test("liveness: a live pid runs, a dead one is interrupted, no pid is interrupted only after 60 s", …)
```

`test/update.test.ts` (use the existing `checkout`/`harness` fixtures; `record` collects patches):
```ts
test("checkForUpdate lists incoming commits newest first and changes nothing", …)
test("record gets the pid first and the result last: updated, with commits, whatsNew and restarted", …)
  // restart stub returns "service"; whatsNew stub returns ["new extension: demo"]
test("record gets up to date", …)
test("record gets each failure with its summary and output, after the rollback", …) // fail: "validate"
test("record gets the rollback move when --to names the previous commit", …)
test("restartAfterUpdate says which way it went", …) // extend the four existing service tests: expect returned value
```
Existing tests whose `restart`/`whatsNew` stubs return `undefined` change to `"none"`/`[]`.

- [ ] **Step 2: Run** — `npx vitest --run test/update.test.ts test/update-state.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `update-state.ts` imports nothing from `src/cli`. `liveness`'s default `alive` is
  `process.kill(pid, 0)` in a try.
- [ ] **Step 4: Run** — same files → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(update): checkForUpdate and an update.json record for chat-started updates"`

### Task 7: Launching detached, and `MessagingContext.update`

**Files:**
- Create: `src/cli/update-launch.ts`
- Modify: `src/cli/main.ts` (`daemon` passes `updater: chatUpdater(APP, home)` to `boot`; usage line unchanged —
  `--from-chat` is hidden)
- Modify: `src/kernel/boot.ts` (`BootOptions.updater?: Updater`; `messaging.update`)
- Modify: `src/kernel/contracts.ts` (`MessagingContext.update`)
- Modify: `test/helpers.ts` (`bootTest` accepts `{ updater }` through a new optional 5th argument `options`)
- Test: new `test/update-launch.test.ts`, `test/messaging-menu.test.ts` (context only)

**Interfaces:**
- Consumes: Task 6's `Updater`, `UpdateCheck`, `UpdateState`, `readUpdateState`, `writeUpdateState`,
  `patchUpdateState`, `liveness`, `updateLog`.
- Produces:
  - `launchPlan(o: { platform: NodeJS.Platform; serviceActive: boolean; node: string; app: string; home: string;
    customHome: boolean; path: string; to: string; now: number }): { cmd: string; args: string[]; detached: boolean }`
    — pure. Service active on Linux: `systemd-run --user --collect --unit japa-update-<now>
    --setenv=PATH=<path> [--setenv=JAPA_HOME=<home>] --property=StandardOutput=append:<log>
    --property=StandardError=append:<log> <node> --disable-warning=ExperimentalWarning <app>/src/cli/main.ts update
    --to <to> --from-chat`, `detached: false`. Otherwise the same node command with `detached: true`.
  - `chatUpdater(app: string, home: string): Updater` — `check` = `checkForUpdate(app)`; `launch` truncates
    `updateLog(home)` (creating `logs/`), builds the plan from `serviceState`/`serviceEnv`, spawns it (`detached`:
    `spawn(..., { detached: true, stdio: ["ignore", log, log] }).unref()`; `systemd-run`: `exec` and throw on a non-zero
    code with its output).
  - `MessagingContext.update`:

```ts
update: {
  /** Throws `Updating from chat isn't available: japa wasn't started as a daemon.` without an updater. */
  check(): Promise<UpdateCheck>;
  /** Refuses (throws `An update is already running (started <ago> ago).`) while one runs; writes the running state, then launches. */
  start(chat: { adapter: string; chat: string }, from: string, to: string, rollback: boolean): Promise<void>;
  state(): Promise<UpdateState | undefined>;
  markReported(): Promise<void>;
};
```

`start` marks an interrupted earlier state reported before writing the new one; a `launch` that throws leaves the
state `failed` with the error as `summary` (and rethrows).

- [ ] **Step 1: Write the failing tests** in `test/update-launch.test.ts`:

```ts
test("with the systemd service active, the update runs as its own transient unit, logging to update.log", …)
  // expect(plan).toEqual({ cmd: "systemd-run", args: [...exact...], detached: false })
test("JAPA_HOME is passed only for a custom home", …)
test("on macOS, or without the service, the update is a detached process", …)
test("start refuses while an update runs and launches nothing", …)
  // boot with a fake updater (launch counts calls); start twice → second rejects "An update is already running"; launches === 1
test("a launch that throws leaves the state failed with its reason", …)
test("without an updater, check says it isn't available", …)
```

- [ ] **Step 2: Run** — `npx vitest --run test/update-launch.test.ts` → FAIL.
- [ ] **Step 3: Implement** as specified. `ago` from `menu/nav.ts` formats `<ago>`.
- [ ] **Step 4: Run** — `npx vitest --run test/update-launch.test.ts test/update.test.ts` → PASS; typecheck PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(update): launch a chat-started update outside the daemon's process tree"`

### Task 8: `/update` menu, Roll back, and reporting

**Files:**
- Create: `src/kernel/messaging/menu/update.ts`
- Create: `src/kernel/messaging/update-report.ts`
- Modify: `src/kernel/messaging/menu/index.ts` (`COMMANDS` gains `{ name: "update", description: "Update japa, or
  roll back the last update" }`; scope `"u"`; `rb:` actions)
- Modify: `src/kernel/messaging/menu/nav.ts` (`createNav` scope type `"s" | "j" | "u"`)
- Modify: `src/kernel/messaging/surface.ts` (report on start and every 2 s)
- Test: `test/messaging-menu.test.ts` (new `describe("update")`), `test/messaging.test.ts`

**Interfaces:**
- Consumes: `MessagingContext.update` (Task 7), `UpdateState`, `liveness`, `updateLog` (Task 6).
- Produces:
  - `updateMenu(nav: Nav, messaging: MessagingContext, activeJobs: () => number, chat: { adapter: string; chat: string }): Page`
  - `rollbackConfirm(nav: Nav, messaging: MessagingContext, chat: {...}, to: string): Page` (in the same file)
  - `updateReport(state: UpdateState, home: string): OutgoingMessage` and
    `interruptedReport(home: string): OutgoingMessage` in `update-report.ts`.
  - Roll back button action: `rb:<from>` (full sha, 43 bytes), not tied to the run token.

Screens and copy (spec §4.1):
- `/update` sends `Checking for updates…`, then edits it to the result.
- Up to date: `✓ japa is up to date (<current7>)`, no buttons. Check error: `✗ <message>`.
- Running or interrupted state → `An update is already running (started <ago> ago).` (running) or the
  `interruptedReport` (and `markReported`), no buttons.
- Otherwise `nav.screen({ title: "<N> new commit(s)", body: "<cur7> → <target7>\n\n<newest 20, one per line>[\n+M more]\n\njapa will restart; <K> job(s) active." })`
  with rows `[[Update now], [Cancel]]`. Update now → `start(chat, current, target, false)` then the screen shows
  `Updating… japa will restart and report back here.` with no buttons; its error → `✗ <message>`. Cancel →
  `Update cancelled.`
- `rb:<sha>` press → `Roll back to <sha7>? japa will restart.` with `[Roll back] [Cancel]`; Roll back →
  `start(chat, <current from check()>, sha, true)`; its result screen is the same `Updating…` text.
- `updateReport`: `updated` → `✓ Updated <from7> → <to7>` (`✓ Rolled back <from7> → <to7>` when `rollback`), then the
  commits, then `New:\n<whatsNew lines>\n\nConfigure them in /settings.` when any, then by `restarted`:
  `foreground` → ``Restart `japa daemon` to apply.``, `stopped` → ``japa's service is stopped; start it with `japa service start`.``;
  button `Roll back` (`rb:<from>`) unless `rollback`. `failed` → `✗ <summary>` + output in a ```` ``` ```` block.
  `up to date` → `✓ japa is up to date (<to7>)`. `interruptedReport` → ``✗ The update was interrupted; see `<updateLog(home)>`.``

Surface reporting: at start and every 2 s, read `messaging.update.state()`; when `chat.adapter` is this adapter and
`reported` is false: finished → send `updateReport` to `chat.chat`, then `markReported()`; interrupted → send
`interruptedReport`, then `markReported()`. A failed send is retried on the next tick. Stop the timer on dispose.

- [ ] **Step 1: Write the failing tests** (fake `Updater` passed through `bootTest`'s options; it records launches and
  can write `update.json` itself to simulate the child):

```ts
describe("update", () => {
  test("/update when current says so", …)            // edited text "✓ japa is up to date (aaaaaaa)"
  test("/update lists new commits, 20 at most, with the active job count", …) // 23 commits → "+3 more"
  test("Update now launches the checked commit and says japa will restart", …) // launch called with target
  test("a second Update now while one runs launches nothing", …)  // Review Focus 1
  test("Cancel ends it without launching", …)
  test("a check error is shown on the screen", …)
  test("an interrupted update is reported once and /update works again after", …)
  test("Roll back asks first, then launches the previous commit as a rollback", …)
  test("the Roll back button still works after a restart; the confirm screen's buttons expire", …)
});
```

`test/messaging.test.ts`:
```ts
test("a finished update is reported once to the chat that asked, with Roll back", …) // write update.json, boot, wait
test("an update report for another adapter is left for it", …)
test("a result written while running is reported within a few seconds", …) // state running w/ live pid → patch to updated
test("a corrupt update.json reports nothing and /update still works", …)  // Review Focus 4
```

- [ ] **Step 2: Run** — `npx vitest --run test/messaging-menu.test.ts -t update` and
  `npx vitest --run test/messaging.test.ts -t update` → FAIL.
- [ ] **Step 3: Implement** as specified. `COMMANDS` order: jobs, status, settings, update.
- [ ] **Step 4: Run** — `npx vitest --run test/messaging-menu.test.ts test/messaging.test.ts` → PASS; the full
  suite `npm test` → PASS; typecheck PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(messaging): /update — check, update, roll back, reported after the restart"`

### Task 9: Docs

**Files:**
- Modify: `README.md` (Telegram section: reply-to-prompt secrets, Decline, `/update` and Roll back; Google section:
  "as your next message in Telegram (the bot deletes it at once)" → "as a reply to its prompt in Telegram (the bot
  deletes it at once)"; Updating section: one sentence on `/update`; `japa chat`'s Ctrl-X; `~/.japa` layout lists
  `update.json` and `logs/update.log`)
- Modify: `docs/superpowers/specs/2026-10-08-japa-messaging-telegram-design.md` (§5.4/§5.6: one line each pointing at
  the new spec) and `docs/superpowers/specs/2026-10-08-japa-install-design.md` (§5: one line on chat-started updates)
- Modify: the new spec's `Status:` to `Implemented`

- [ ] **Step 1: Edit the docs** as listed; check every command name and message quoted matches the code
  (`grep -n "Reply to this message" -r src extensions README.md`).
- [ ] **Step 2: Run** — `npm test` and `npm run typecheck` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "docs: secret prompts, /update and markdown in chats"`
