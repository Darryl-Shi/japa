# Messaging Gateways and Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach the CoS from a phone: every root turn knows which surface (and chat) started it, a core `messaging` contract lets chat platforms plug in as thin transports with all shared behaviour in the kernel, and `extensions/telegram` connects Telegram over Bot API long polling.

**Architecture:** A submission's origin lives in its `requestId` (`surface:<surface>:<chat>:<id>`; every other prefix is proactive). `root.replies` walks the root's entries in id order after a cursor (an entry id): each user entry makes its submission's origin current, each assistant entry with text is a reply with the current origin — so a steer or follow-up, being a later user entry of the same run, takes over the origin. The kernel starts one messaging surface per `messaging` adapter (`src/kernel/messaging/`), which does the owner check, merging, images, secrets, commands, the settings menu, routing, splitting and typing; the Telegram adapter is plain `fetch` against the Bot API.

**Tech Stack:** TypeScript on Node 24 (native type stripping, no build step), `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, vitest with the faux provider; a local `node:http` server as the fake Bot API.

**Spec:** `docs/superpowers/specs/2026-10-08-japa-messaging-telegram-design.md`, extending `docs/superpowers/specs/2026-10-07-japa-design.md` (the main spec). Already in code and binding: `…-remove-extension-contracts-design.md` (contracts are the fixed `CONTRACTS` map and `ACTIVATION_ORDER` in `src/kernel/contracts.ts`) and `…-stateless-cos-design.md` (the root resets after every settled run, `src/kernel/reset.ts`; there is no `/new` and no `root.reset` here).

## Global Constraints

- Prime directive: don't overcomplicate. Minimal code, no code for the sake of code, no speculative options. No new dependencies (Telegram is plain `fetch`).
- `npm test` and `npm run typecheck` pass after every task. `tsconfig` has `erasableSyntaxOnly`: no enums, no constructor parameter properties.
- Origin `requestId`: `surface:<surface>:<chat>:<id>`, each part `encodeURIComponent`-ed; `chat` empty when absent; `id` a `randomUUID()` when absent. Every other prefix (`trigger:`, `report:`, `job:`, `secret:`, `rollback:`, `rollback-none:`, `safe-mode:`, `memory:`) is **proactive**; an input without a `requestId` is `{ surface: "gateway" }`.
- Activation order: `provider, environment, tool, trigger, surface, messaging`.
- Merge window **1.5 s** (1 500 ms) between consecutive owner messages; texts joined by a blank line (`"\n\n"`).
- Typing every **4 s** (4 000 ms) while a run of the surface's own origin is active.
- Telegram `maxMessageChars` **4096**; button actions **≤ 64 bytes**; file limit **20 MB** (`20 * 1024 * 1024` bytes); `getUpdates` timeout **50 s**; backoff **1 s doubling to 60 s**; `429` waits `retry_after` seconds.
- Attachments: `~/.japa/attachments/<date>/<id>.<ext>` (`<home>/attachments/<YYYY-MM-DD>/…`), ignored by git.
- Owner setting: `extensions.<adapter>.owner`, a string user id, added to every messaging adapter's settings schema by the kernel.
- Contract docs, verbatim: `A chat platform the user talks to the CoS through. Implement only transport; japa provides commands, settings, secrets, routing and images.`
- User-facing strings, verbatim: `Not authorized. Your <adapter> user id is <N>.` · `(this model cannot see images)` · ``japa needs `<name>`: <reason>. Send it as your next message; I'll delete it at once.`` · `Couldn't delete your message — please delete it yourself.` · `Not changed: <reason>` · `This menu expired — send /settings again.` · `I can only read text and images here.`
- Commands: `/jobs`, `/status`, `/settings`; commands never reach the CoS.
- Telegram HTML subset: `b i s u code pre a blockquote`; everything else escaped.

## Review Focus

- **Telegram not set up** — the case for nearly every install, since `telegram` becomes a default extension. Boot must show no error, raise no secret request and call no Bot API; the bot starts the moment the token is provided. → Task 11, `a default install has Telegram dormant` and `without a token the bot waits, asking nothing`.
- **The CoS sets the owner from the id the user read out**, very likely as a number (`settings_set` with `42`). User `"42"` must then be authorized. → Task 3, `an owner id given as a number authorizes that user`.
- **A message sent just before the daemon stops** (inside the 1.5 s merge window) must still reach the CoS. → Task 3, `a message still in the merge window is submitted when the daemon stops`.
- **A reply in flight when the daemon stops** must be sent after the restart, not skipped as failed. → Task 4, `a reply in flight at the stop is sent after the restart`.
- **The CoS's model call fails** (no API key, provider down): the phone must show the error, not silence. → Task 2, `a model error reaches replies as its message`.

## Decisions the spec leaves open

- **Reply origin and cursor.** A reply's cursor is its assistant entry's id. Its origin is that of the newest user entry before it whose submission is known; a user entry's submission comes from `Storage.scanSubmissions` (records carry `entry` and `requestId`) at start, then from `harness.subscribeCommits` publications. A user entry with no submission keeps the current origin. Algorithm in Task 2.
- **`receive` resolves once the kernel has taken the message** (into the merge buffer, or handled). Telegram confirms a batch after that. Telegram can't fetch newer updates without confirming older ones, so merging across batches needs this; the buffer is submitted when the surface stops, and only a hard crash inside the 1.5 s window can lose it.
- **Chats.** Only private chats reach the kernel (the adapter drops the rest). Replies of the surface's own origin go to `origin.chat`; proactive replies go to the chat `<owner>` (a Telegram private chat's id is the user's id) and are skipped while no owner is set.
- **The owner** is read through the providing extension's `KernelContext.settings().owner`; Telegram's extension and adapter are both named `telegram`.
- **Kernel services beyond `SurfaceContext`** (cursor storage, the shared settings and rollback paths, calling a registered tool) reach the messaging surface as `KernelContext.messaging`, built once in boot.
- **Telegram without a token waits dormant.** Extensions get `secretProvided(name)` (resolves when the user next provides it) and `requestSecret(name, why)` (asks, then resolves the same way). The CoS asks for `telegram.botToken` when the user wants Telegram (the extension's summary says so); a 401 makes the adapter ask itself.
- **Menu changes reuse the CoS's paths:** `setSetting` and `rollBackAndLog` are factored out of `settings_set` and `rollback`; schedules go through the registered `schedule_list` (which gains `details`) and `schedule_remove` tools. The menu does not undo; its changes are in `japa.changes`, undoable with `change_undo`.
- **"Restart notice as in `japa rollback`":** the daemon applies a rollback live, so the menu and the `rollback` tool append `reconcile()`'s notices (`<name>: storage/secrets changes apply after a restart`), not "restart the daemon".
- **Reply text** is the assistant message's text parts, then its `errorMessage` on a new line when set.
- **Telegram retries:** sends retry until the 60 s wait has failed too (8 attempts), then throw (the kernel logs and skips). Polling retries forever, its wait capped at 60 s.

---

## File Structure

```
src/kernel/origin.ts                  NEW  requestIdFor(), originOf()
src/kernel/replies.ts                 NEW  watchReplies()
src/kernel/status.ts                  NEW  statusText() — shared by `japa status` and /status
src/kernel/messaging/surface.ts       NEW  startMessaging(), MessagingDoc: owner, input, merge, output, typing, secrets
src/kernel/messaging/split.ts         NEW  splitMessage()
src/kernel/messaging/attachments.ts   NEW  inputOf(): save images, build the CoS input
src/kernel/messaging/menu.ts          NEW  COMMANDS, HELP, createMenu(): /jobs, /status, /settings, buttons
src/kernel/contracts.ts               Origin, Reply, messaging types, `messaging` contract, ACTIVATION_ORDER,
                                      SurfaceContext.root.submit/replies, KernelContext.messaging/secretProvided/requestSecret
src/kernel/boot.ts                    surface submit/replies, MessagingContext, secret waiters
src/kernel/settings-tools.ts          owner schema; SettingsDeps, setSetting()
src/kernel/install.ts                 rollBackAndLog()
src/kernel/changes.ts                 Commit type
src/kernel/secret-requests.ts         addSecretRequest(); fulfilSecret returns the name
src/kernel/capabilities.ts            messaging adapters listed as surfaces
src/kernel/jobs/state.ts              recent()
src/kernel/workspace.ts               attachments/ ignored, also in existing workspaces
src/cli/main.ts                       `japa status` prints statusText()
src/sdk.ts                            exports the new types
extensions/gateway/index.ts           submits with origin { surface: "gateway" }
extensions/schedule/index.ts          schedule_list returns details
extensions/telegram/index.ts          NEW  the extension, the adapter, polling
extensions/telegram/api.ts            NEW  botApi(), ApiError, backoff()
extensions/telegram/html.ts           NEW  toHtml()
extensions/telegram/updates.ts        NEW  Update, parseUpdate()
skills/building-extensions/SKILL.md   messaging section
README.md, docs/superpowers/specs/2026-10-07-japa-design.md
test/origin.test.ts, test/replies.test.ts, test/split.test.ts, test/messaging.test.ts,
test/messaging-menu.test.ts, test/telegram.test.ts                                   NEW
test/messaging-helpers.ts (fakeAdapter, bootMessaging), test/telegram-helpers.ts (fakeBotApi, kernelStub)  NEW
test/helpers.ts                       + probe(), echo()
```

---

### Task 1: Submissions carry their origin

**Files:**
- Create: `src/kernel/origin.ts`, `test/origin.test.ts`
- Modify: `src/kernel/contracts.ts` (`Origin`, `SurfaceContext.root.submit`), `src/kernel/boot.ts` (surface `submit`), `extensions/gateway/index.ts:30`, `src/sdk.ts`
- Test: `test/origin.test.ts`, `test/gateway.test.ts`, `test/helpers.ts` (move `probe()` here from `test/secret-requests.test.ts` and import it there)

**Interfaces:**
- Produces:
  - `type Origin = { surface: string; chat?: string } | "proactive"` in `contracts.ts`, exported from `src/sdk.ts`.
  - `SurfaceContext.root.submit(input: UserInput, mode?: "steer" | "followUp", origin?: { surface: string; chat?: string; id?: string }): Promise<void>` (`UserInput` from pi-durable). With an origin the submission's `requestId` is `requestIdFor(origin)`; without, it has none, as today.
  - `requestIdFor(origin: { surface: string; chat?: string; id?: string }): string` and `originOf(requestId: string | undefined): Origin` in `src/kernel/origin.ts` (values in Global Constraints; `originOf` omits an empty `chat`).
  - `probe(): { extension: JapaExtension; surface(): SurfaceContext }` in `test/helpers.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/origin.test.ts
test("a surface origin is encoded in the requestId", () => {
  expect(requestIdFor({ surface: "telegram", chat: "42", id: "7" })).toBe("surface:telegram:42:7");
  expect(requestIdFor({ surface: "gateway" })).toMatch(/^surface:gateway::[0-9a-f-]{36}$/);
  expect(requestIdFor({ surface: "x", chat: "a:b", id: "1" })).toBe("surface:x:a%3Ab:1");
});

test("origins are read back from requestIds", () => {
  expect(originOf("surface:telegram:42:7")).toEqual({ surface: "telegram", chat: "42" });
  expect(originOf("surface:gateway::d1e2")).toEqual({ surface: "gateway" });
  expect(originOf("surface:x:a%3Ab:1")).toEqual({ surface: "x", chat: "a:b" });
  expect(originOf(undefined)).toEqual({ surface: "gateway" });
  for (const id of ["trigger:schedule:1:5", "report:1:2", "job:9", "secret:3", "rollback:abc",
    "rollback-none:echo:abc", "safe-mode:abc", "memory:v2-loops"]) expect([id, originOf(id)]).toEqual([id, "proactive"]);
});

test("a surface input with an id is admitted once", async () => {
  const { extension, surface } = probe();
  const { daemon } = await bootTest({}, [extension]);
  await surface().root.submit("hi", undefined, { surface: "fake", chat: "9", id: "5" });
  await surface().root.submit("hi", undefined, { surface: "fake", chat: "9", id: "5" });
  await daemon.root.waitForIdle(ctx);
  expect((await texts(daemon.root, "user")).filter((t) => t === "hi")).toHaveLength(1);
  expect(await daemon.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "surface:fake:9:5"), ctx)).toBeDefined();
  await daemon.close();
});

test("a surface submits text and image parts", async () => {
  const parts = [{ type: "text", text: "look" }, { type: "image", data: "aGk=", mimeType: "image/png" }] as const;
  await surface().root.submit([...parts]);
  // the oldest pi.user entry's model[0].content toEqual(parts)
});
```

In `test/gateway.test.ts`:

```ts
test("the gateway submits with its origin and still shows input from other surfaces", async () => {
  // bootTest with probe(); attach a client; client submits "hello"; the probe submits "from the phone" with { surface: "fake", chat: "9" }
  await vi.waitFor(() => expect(JSON.stringify(seen)).toMatch(/"requestId":"surface:gateway::[0-9a-f-]{36}"/));
  await vi.waitFor(() => expect(JSON.stringify(seen)).toContain("from the phone"));
});
```

(The `submission` agent events carry each record's `requestId`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/origin.test.ts test/gateway.test.ts`
Expected: FAIL — `src/kernel/origin.ts` does not exist; the gateway's submissions have no `requestId`.

- [ ] **Step 3: Implement**

`origin.ts` as above (parse with `/^surface:([^:]*):([^:]*):/`). Boot's surface `submit` spreads `requestId` only when an origin is given. The gateway calls `ctx.root.submit(m.text, m.mode, { surface: "gateway" })`.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src extensions/gateway test
git commit -m "feat(surface): submissions carry their origin"
```

---

### Task 2: `root.replies`

**Files:**
- Create: `src/kernel/replies.ts`, `test/replies.test.ts`
- Modify: `src/kernel/contracts.ts` (`Reply`, `SurfaceContext.root.replies`), `src/kernel/boot.ts`, `src/sdk.ts`

**Interfaces:**
- Consumes: `originOf` (Task 1), `probe()` (Task 1), `held()`, `script()`, `say()` from `test/jobs-helpers.ts`.
- Produces:
  - `type Reply = { cursor: string; origin: Origin; text: string }`, exported from `src/sdk.ts`.
  - `SurfaceContext.root.replies(listener: (r: Reply) => void | Promise<void>, after?: string): Promise<{ stop(): Promise<void> }>` — each finished assistant message with text, in entry order, one at a time (a returned promise is awaited before the next); after `after`, or from the newest entry at the call when absent. `stop()` waits for the delivery in progress.
  - `watchReplies(harness: Harness, storage: Storage, root: Conversation, listener: (r: Reply) => void | Promise<void>, after?: string): Promise<{ stop(): Promise<void> }>` in `src/kernel/replies.ts`; boot wires `replies` to it with the opened storage (capture it in a `const`).

- [ ] **Step 1: Write the failing tests**

Each test boots with `probe()` and collects `replies` into an array; `script(faux, …)` answers each input with `say(\`re: ${text}\`)` unless stated.

```ts
test("each assistant message with text is a reply, in order, without tool calls", async () => {
  // "go" is answered by [fauxText("Looking."), fauxToolCall("settings_get", {})] (stopReason "toolUse"), then say("Done.")
  await ask(daemon, "go");
  await vi.waitFor(() => expect(replies.map((r) => r.text)).toEqual(["Looking.", "Done."]));
  expect(Number(replies[0]!.cursor)).toBeLessThan(Number(replies[1]!.cursor));
});

test("a reply carries the origin of the input it answers", async () => {
  await surface().root.submit("a", undefined, { surface: "fake", chat: "9" });
  await daemon.root.waitForIdle(ctx);
  await ask(daemon, "b");                       // no requestId
  await emit({ key: "k", text: "c" });          // a `tick` trigger extension, as in test/activation.test.ts
  await vi.waitFor(() => expect(replies.map((r) => [r.text, r.origin])).toEqual([
    ["re: a", { surface: "fake", chat: "9" }], ["re: b", { surface: "gateway" }], ["re: [tick] c", "proactive"]]));
});

test.each(["steer", "followUp"] as const)("a %s takes over the run's origin", async (mode) => {
  // gateway input "first" is answered by a held say("a1"); while held, the probe submits "second" with `mode` and
  // { surface: "fake", chat: "9" }; release; "second" is answered say("a2")
  await vi.waitFor(() => expect(replies.map((r) => [r.text, r.origin])).toEqual([
    ["a1", { surface: "gateway" }], ["a2", { surface: "fake", chat: "9" }]]));
});

test("replies resume after a cursor", async () => {
  // three inputs answered; a second watcher started with replies[0].cursor
  await vi.waitFor(() => expect(again.map((r) => r.text)).toEqual([replies[1]!.text, replies[2]!.text]));
});

test("without a cursor, replies start from now", async () => {
  // ask "old"; start a watcher; ask "new"
  await vi.waitFor(() => expect(later.map((r) => r.text)).toEqual(["re: new"]));
});

test("a model error reaches replies as its message", async () => {
  faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "No API key for faux" })]);
  await ask(daemon, "hi");
  await vi.waitFor(() => expect(replies.at(-1)!.text).toBe("No API key for faux"));
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/replies.test.ts`
Expected: FAIL — `replies` is not a function.

- [ ] **Step 3: Implement `watchReplies`**

```
requestIds = Map<entryId, requestId | undefined>          // user entry → its submission's requestId
subscribe harness.subscribeCommits first: for each change of the root —
  type "submission", value.type "input", value.entry set → requestIds.set(value.entry, value.requestId)
  type "entry" → wake()                                    // listener only records and schedules; no Session calls
fill requestIds from storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 500, cursor, ctx), every page
last = after ? Number(after) : id of the newest root entry (0 when none)
origin = originOf(requestIds.get(e.id)) for the newest pi.user entry e with id ≤ last that requestIds has; else { surface: "gateway" }
pump (one at a time; a wake during a pump runs it again):
  entries = every page of root.entries({ minEntryId: last + 1 }, 200, cursor, ctx) (newest first), reversed
  for e of entries:
    pi.user with requestIds.has(e.id) → origin = originOf(requestIds.get(e.id))
    pi.assistant → text = [text parts joined, errorMessage].filter(Boolean).join("\n"); when non-empty,
                   await listener({ cursor: String(e.id), origin, text })
    last = e.id
pump once at start (catch-up)
stop(): unsubscribe, then await the pump in progress
```

A listener that throws is logged with `console.error` and the pump moves on to the next entry.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(surface): root.replies with origins and a durable cursor"
```

---

### Task 3: The `messaging` contract and the surface's input

**Files:**
- Create: `src/kernel/messaging/surface.ts`, `test/messaging-helpers.ts`, `test/messaging.test.ts`
- Modify: `src/kernel/contracts.ts`, `src/kernel/settings-tools.ts`, `src/kernel/capabilities.ts`, `src/sdk.ts`
- Test: `test/messaging.test.ts`, `test/activation.test.ts`, `test/capabilities.test.ts`

**Interfaces:**
- Consumes: `SurfaceContext.root.submit` with origin (Task 1).
- Produces:
  - `MessagingAdapter`, `MessagingAdapterContext`, `Incoming`, `OutgoingMessage` in `contracts.ts`, exactly as spec §4, exported from `src/sdk.ts`.
  - `requireFields` accepts `"number"`. The `messaging` contract: docs verbatim (Global Constraints), `runtime`, `many`, `validate: requireFields(c, { name: "string", maxMessageChars: "number", start, send, edit, delete, typing, commands: "function" })`, `activate: (c, ctx) => startMessaging(c as MessagingAdapter, ctx)`. `ACTIVATION_ORDER` ends `"surface", "messaging"`.
  - `startMessaging(adapter: MessagingAdapter, kernel: KernelContext): Promise<Dispose>` and `MERGE_MS = 1500` in `src/kernel/messaging/surface.ts`.
  - `settingsSchema(e: JapaExtension): TSchema | undefined` in `settings-tools.ts`: for an extension that provides `messaging`, `Type.Object({ ...e.settings?.properties, owner: Type.Optional(Type.String()) })`; otherwise `e.settings`. `validate` builds its schemas with it.
  - `capabilities()`: `Surfaces:` lists surface names, then messaging adapter names.
  - In `test/messaging-helpers.ts`: `fakeAdapter({ name = "fake", maxMessageChars = 4096 } = {})` returning `{ adapter, extension, sent: { chat; id; markdown; buttons? }[], edited: { chat; messageId; markdown; buttons? }[], deleted: { chat; messageId }[], typing: string[], commands: { name; description }[][], receive(m: Partial<Incoming>): Promise<void>, failSend?: (m: OutgoingMessage) => boolean, failDelete: boolean, holdSends: boolean, press(label: string): Promise<void> }` — `receive` defaults `chat`/`user` to `"42"` and numbers `id`/`messageId` from a counter; `send` returns ids `"1"`, `"2"`, …; `holdSends` makes a send wait until the adapter is stopped, then reject; `press` receives the action of the button labelled `label` in the newest sent or edited message, with that message's id. `bootMessaging(fake, settings = {}, kit?)` = `bootTest({ extensions: { fake: { owner: "42" } }, ...settings }, [fake.extension], kit)`. `sleep(ms)`.

`receive` in this task: messages are handled one at a time in arrival order; `receive` resolves once the message is buffered or handled and never rejects (errors go to `console.error` as `<adapter>: <message>`). A message from a user other than `kernel.settings().owner` (or any user while it is unset) gets `adapter.send(m.chat, { markdown: "Not authorized. Your <adapter> user id is <user>." })` and nothing else. An owner message with `text` joins the buffer unless one with the same `id` is already in it; `MERGE_MS` after the buffer's latest message it is submitted: `kernel.surface.root.submit(texts.join("\n\n"), "followUp", { surface: adapter.name, chat: first.chat, id: first.id })`. `command` and `action` messages are ignored until Task 7. Dispose: stop the adapter, then submit the buffer at once; later `receive` calls are ignored.

- [ ] **Step 1: Write the failing tests**

```ts
test("the messaging contract validates adapters and activates after surfaces", () => {
  expect(ACTIVATION_ORDER).toEqual(["provider", "environment", "tool", "trigger", "surface", "messaging"]);
  const contract = CONTRACTS.get("messaging")!;
  expect(contract.validate(fakeAdapter().adapter)).toBeUndefined();
  expect(contract.validate({ ...fakeAdapter().adapter, send: undefined })).toBe("send must be a function");
  expect(contract.validate({ ...fakeAdapter().adapter, maxMessageChars: "4096" })).toBe("maxMessageChars must be a number");
});

test("anyone but the owner gets their user id and goes no further", async () => {
  const fake = fakeAdapter();
  const { daemon } = await bootMessaging(fake, { extensions: {} });     // no owner yet
  await fake.receive({ user: "7", chat: "7", text: "hi" });
  expect(fake.sent).toMatchObject([{ chat: "7", markdown: "Not authorized. Your fake user id is 7." }]);
  await sleep(2000);
  expect(await texts(daemon.root, "user")).toEqual([]);
});

test("an owner id given as a number authorizes that user", async () => {
  // bootMessaging(fake, { extensions: {} })
  expect(await tool(daemon, faux, "settings_set", { path: "extensions.fake.owner", value: 42 })).toMatch(/^Set /);
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).extensions.fake.owner).toBe("42");
  await fake.receive({ text: "hi" });
  await waitFor(async () => (await texts(daemon.root, "user")).includes("hi"));
  expect(await tool(daemon, faux, "settings_set", { path: "extensions.fake.owner", value: {} })).toMatch(/^Not changed: .*owner/);
});

test("the owner's messages within 1.5 s are one input with the surface's origin", async () => {
  await fake.receive({ id: "11", text: "part one" });
  await sleep(300);
  await fake.receive({ id: "12", text: "part two" });
  await waitFor(async () => (await texts(daemon.root, "user")).includes("part one\n\npart two"));
  expect(await daemon.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "surface:fake:42:11"), ctx)).toBeDefined();
  await sleep(2000);
  await fake.receive({ text: "later" });
  await waitFor(async () => (await texts(daemon.root, "user")).includes("later"));
});

test("a replayed message is admitted once, inside the window and after it", async () => {
  await fake.receive({ id: "9", text: "x" });
  await fake.receive({ id: "9", text: "x" });
  await sleep(2000);
  await fake.receive({ id: "9", text: "x" });
  await sleep(2000);
  expect((await texts(daemon.root, "user")).filter((t) => t.startsWith("x"))).toEqual(["x"]);
});

test("a message still in the merge window is submitted when the daemon stops", async () => {
  // sqlite home, as test/boot.test.ts "history survives a restart on sqlite"; receive "bye", close at once, boot again
  expect(await texts(again.root, "user")).toContain("bye");
});
```

In `test/capabilities.test.ts` add `{ name: "fake", summary: "Fake chat", provides: { messaging: [{ name: "fake" }] } }` and expect `"Surfaces: gateway, fake"`. In `test/activation.test.ts`'s order probe add a `messaging` adapter (`fakeAdapter().adapter` with a `start` that pushes `"messaging"`) and expect `["setup", "trigger", "surface", "messaging"]`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/messaging.test.ts test/capabilities.test.ts`
Expected: FAIL — `unknown contract "messaging"`.

- [ ] **Step 3: Implement the contract, the input path, the owner schema and the capabilities line**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(messaging): the messaging contract; owner check and merged input"
```

---

### Task 4: The surface's output

**Files:**
- Create: `src/kernel/messaging/split.ts`, `test/split.test.ts`
- Modify: `src/kernel/messaging/surface.ts`, `src/kernel/contracts.ts` (`MessagingContext`, `KernelContext.messaging`), `src/kernel/boot.ts`
- Test: `test/split.test.ts`, `test/messaging.test.ts`

**Interfaces:**
- Consumes: `SurfaceContext.root.replies` (Task 2), `originOf` (Task 1), `fakeAdapter` / `bootMessaging` (Task 3).
- Produces:
  - `type MessagingContext = { cursor(adapter: string): Promise<string | undefined>; saveCursor(adapter: string, cursor: string): Promise<void> }` (Task 8 adds three members) and `KernelContext.messaging: MessagingContext`; boot builds one object, shared by every extension's `KernelContext`.
  - `MessagingDoc` in `surface.ts`: `defineDoc<{ cursors: Record<string, string> }>({ kind: "japa.messaging", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ cursors: {} }) })`, on the root; boot's `cursor` reads it with `harness.snapshot`, `saveCursor` writes it with `root.commit`.
  - `splitMessage(markdown: string, max: number): string[]` in `split.ts`; `TYPING_MS = 4000` in `surface.ts`.

Behaviour: at start, `kernel.surface.root.replies(handle, await kernel.messaging.cursor(adapter.name))`. A reply goes to `origin.chat` when `origin.surface === adapter.name`, to the owner when `"proactive"` (skipped without one), nowhere otherwise. Its parts from `splitMessage(text, adapter.maxMessageChars)` are sent in order; a send that throws logs `<adapter>: couldn't send a reply: <message>` and skips the rest of that reply. Then `saveCursor`. Once dispose has begun, a failed send is neither logged nor saved (the reply is sent again after the restart). Typing comes from `kernel.surface.root.events`: busy is `snapshot.run !== undefined`, then `run_start` / `run_end`; the run's origin is `originOf(record.requestId)` of the latest `submission` event whose record is `placed`. While busy with this adapter's origin, call `adapter.typing(origin.chat)` at once and every `TYPING_MS`, ignoring errors. Dispose order: mark stopped, stop the adapter, submit the merge buffer, stop the replies, events and later subscriptions, clear the typing timer.

`splitMessage`: while the rest is longer than `max`, cut at the last `"\n\n"`, else `"\n"`, else `" "` that leaves a part of at most `max` characters (counting a closing fence it may need), else hard at the limit; the separator is dropped. A part that ends inside a ```` ``` ```` block gets `"\n```"` appended, and the next part starts with that block's opening fence line (e.g. ```` ```ts ````) and a newline.

- [ ] **Step 1: Write the failing tests**

````ts
// test/split.test.ts
test("a short message is one part", () => expect(splitMessage("hi", 4096)).toEqual(["hi"]));
test("parts break at paragraphs first, then lines", () => {
  const a = "a".repeat(3000), b = "b".repeat(3000);
  expect(splitMessage(`${a}\n\n${b}`, 4096)).toEqual([a, b]);
  expect(splitMessage(`${a}\n${b}`, 4096)).toEqual([a, b]);
});
test("then at words, and a word over the limit is cut", () => {
  const parts = splitMessage("word ".repeat(2000).trim(), 4096);
  expect(parts.every((p) => p.length <= 4096 && !p.startsWith(" ") && !p.endsWith(" "))).toBe(true);
  expect(splitMessage("x".repeat(5000), 4096)).toEqual(["x".repeat(4096), "x".repeat(904)]);
});
test("a code block split across parts is closed and reopened", () => {
  const code = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const parts = splitMessage(`Here:\n\n\`\`\`ts\n${code}\n\`\`\``, 4096);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every((p) => p.length <= 4096 && (p.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
  expect(parts[1]!.startsWith("```ts\n")).toBe(true);
});
````

In `test/messaging.test.ts` (`script` answers each input `say(\`re: ${text}\`)`):

```ts
test("the owner's replies and proactive replies are sent; japa chat's are not", async () => {
  await fake.receive({ text: "hi" });
  await waitFor(() => fake.sent.some((s) => s.markdown === "re: hi"));
  await ask(daemon, "from the terminal");            // gateway origin
  await emit({ key: "k", text: "tick" });            // proactive, from a `tick` trigger extension
  await waitFor(() => fake.sent.some((s) => s.markdown === "re: [tick] tick"));
  expect(fake.sent.map((s) => [s.chat, s.markdown])).toEqual([["42", "re: hi"], ["42", "re: [tick] tick"]]);
});

test("a long reply is sent in parts", async () => {
  // fakeAdapter({ maxMessageChars: 20 }); the answer is say("first paragraph\n\nsecond paragraph")
  await waitFor(() => fake.sent.length === 2);
  expect(fake.sent.map((s) => s.markdown)).toEqual(["first paragraph", "second paragraph"]);
});

test("typing shows every 4 s while the owner's run is going, and not for japa chat's", { timeout: 20_000 }, async () => {
  // the owner's "hi" is answered by a held say("ok"); sleep(4500)
  expect(fake.typing.filter((c) => c === "42").length).toBeGreaterThanOrEqual(2);
  // release, wait for "ok"; a gateway input with a held answer for 4.5 s adds no typing
});

test("a reply that fails to send is logged and skipped", async () => {
  fake.failSend = (m) => m.markdown === "re: bad";
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await fake.receive({ text: "bad" });
  await sleep(2000);
  await fake.receive({ text: "good" });
  await waitFor(() => fake.sent.some((s) => s.markdown === "re: good"));
  expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^fake: couldn't send a reply: /));
});

test("a reply in flight at the stop is sent after the restart, and a sent one is not sent again", async () => {
  // sqlite home. Boot 1: "one" → "re: one" sent; then fake.holdSends = true; "two"; wait until a send is held; close.
  // Boot 2 with a new fakeAdapter:
  await waitFor(() => fake2.sent.length > 0);
  await sleep(500);
  expect(fake2.sent.map((s) => s.markdown)).toEqual(["re: two"]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/split.test.ts test/messaging.test.ts`
Expected: FAIL — `split.ts` does not exist; nothing is sent.

- [ ] **Step 3: Implement `splitMessage`, the reply path, the cursor and typing**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(messaging): replies routed by origin, split, typing, durable cursor"
```

---

### Task 5: Images in

**Files:**
- Create: `src/kernel/messaging/attachments.ts`
- Modify: `src/kernel/messaging/surface.ts`, `src/kernel/workspace.ts`
- Test: `test/messaging.test.ts`, `test/workspace.test.ts`

**Interfaces:**
- Consumes: the merge buffer (Task 3); `carryOver()` from `test/helpers.ts`.
- Produces: `inputOf(home: string, messages: Incoming[], vision: boolean): UserInput` — saves each message's images to `<home>/attachments/<YYYY-MM-DD>/<id>.<ext>` (`new Date().toISOString().slice(0, 10)`; the message's `id`, plus `-<n>` for its second and later images; `jpg`/`png`/`gif`/`webp` by MIME type, otherwise its subtype). Without images it returns the texts joined by `"\n\n"`. With images the text is the joined texts (if any), then one `[image saved to <path>]` line per image, joined by `"\n"`; with `vision` the input is `[{ type: "text", text }, …{ type: "image", data: <base64>, mimeType }]`, without it the string `text + "\n(this model cannot see images)"`.
- `vision` = `kernel.models.getModel(m.provider, m.modelId)?.input.includes("image")` for `m = kernel.surface.status().model`.
- Messages with `images` join the buffer like text; the buffer is submitted as `inputOf(kernel.home, buffer, vision)`.
- `workspace.ts`: `IGNORED` gains `"attachments/"`; `ensureWorkspace` appends the `IGNORED` lines missing from an existing `.gitignore`.

- [ ] **Step 1: Write the failing tests**

```ts
const PNG = new Uint8Array([137, 80, 78, 71]);
const day = () => new Date().toISOString().slice(0, 10);

test("an image is saved under attachments and sent as an image part with its path", async () => {
  await fake.receive({ id: "31", text: "look", images: [{ data: PNG, mimeType: "image/png" }] });
  const path = join(home, "attachments", day(), "31.png");
  await waitFor(() => existsSync(path));
  expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
  // the newest pi.user entry's content:
  expect(content).toEqual([{ type: "text", text: `look\n[image saved to ${path}]` },
    { type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" }]);
  expect(await carryOver(daemon)).toContain(`[image saved to ${path}]`);
});

test("an album inside the window is one input with every image", async () => {
  // receive ids "41" and "42", each with one image/jpeg, 200 ms apart
  expect(content).toMatchObject([{ type: "text", text: `[image saved to ${p41}]\n[image saved to ${p42}]` },
    { type: "image" }, { type: "image" }]);
});

test("a model without image input gets only the path notes", async () => {
  // kit = testKit({ models: [{ id: "blind", input: ["text"] }] })
  expect(content).toBe(`look\n[image saved to ${path}]\n(this model cannot see images)`);
});
```

In `test/workspace.test.ts`:

```ts
test("attachments are ignored by git, also in a workspace made before them", () => {
  // a home whose .gitignore holds today's lines without "attachments/"; ensureWorkspace twice
  expect(readFileSync(join(home, ".gitignore"), "utf8").split("\n").filter((l) => l === "attachments/")).toHaveLength(1);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/messaging.test.ts test/workspace.test.ts`
Expected: FAIL — images are dropped; `.gitignore` lacks `attachments/`.

- [ ] **Step 3: Implement `inputOf`, the buffer change and the `.gitignore` update**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(messaging): images in, saved under attachments"
```

---

### Task 6: Secrets in chat

**Files:**
- Modify: `src/kernel/messaging/surface.ts`
- Test: `test/messaging.test.ts`

**Interfaces:**
- Consumes: `kernel.surface.secrets.pending` / `fulfil`, `adapter.delete`.
- Produces (in `surface.ts`): an `awaiting` request id. On each `pending` delivery: an empty list clears it; otherwise, when an owner is set and `pending[0].id !== awaiting`, send ``japa needs `<name>`: <why>. Send it as your next message; I'll delete it at once.`` to the owner and set `awaiting = pending[0].id`. While `awaiting` is set, the owner's next message with `text` (no `command`/`action`) is `fulfil(awaiting, text)`, then `awaiting` is cleared and the message deleted with `adapter.delete(m.chat, m.messageId)`; if deleting throws, send `Couldn't delete your message — please delete it yourself.` It never joins the merge buffer. A message with `command` clears `awaiting` (the request stays pending and is asked again on the next change of the list).

- [ ] **Step 1: Write the failing tests**

```ts
// script: "connect" → call("secret_request", { name: "svc.token", why: "to sync" })
const PROMPT = "japa needs `svc.token`: to sync. Send it as your next message; I'll delete it at once.";

test("a pending secret request is asked for; the next text fulfils it and is deleted", async () => {
  await fake.receive({ text: "connect" });
  await waitFor(() => fake.sent.some((s) => s.markdown === PROMPT));
  await fake.receive({ text: "s3cr3t", messageId: "77" });
  expect(fake.deleted).toEqual([{ chat: "42", messageId: "77" }]);
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
  await waitFor(async () => (await texts(daemon.root, "user")).includes("[secret svc.token provided]"));
  expect(JSON.stringify((await daemon.root.entries({}, 500, undefined, ctx)).items)).not.toContain("s3cr3t");
});

test("if the message can't be deleted, the secret is still stored and the user is told", async () => {
  fake.failDelete = true;
  // connect, prompt, "s3cr3t"
  expect(fake.sent.at(-1)!.markdown).toBe("Couldn't delete your message — please delete it yourself.");
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
});

test("a command cancels the prompt; the request stays pending", async () => {
  // connect, prompt; then a command and a text
  await fake.receive({ command: "status" });
  await fake.receive({ text: "hello" });
  await waitFor(async () => (await texts(daemon.root, "user")).includes("hello"));
  expect((await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending).toMatchObject([{ name: "svc.token" }]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/messaging.test.ts -t secret`
Expected: FAIL — no prompt is sent.

- [ ] **Step 3: Implement the secret prompt and fulfilment**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(messaging): secret requests answered in chat and deleted"
```

---

### Task 7: Commands — `/jobs`, `/status`, help

**Files:**
- Create: `src/kernel/messaging/menu.ts`, `src/kernel/status.ts`, `test/messaging-menu.test.ts`
- Modify: `src/kernel/messaging/surface.ts`, `src/kernel/jobs/state.ts`, `src/cli/main.ts` (`status` prints `statusText`)
- Test: `test/messaging-menu.test.ts`, `test/jobs-state.test.ts`

**Interfaces:**
- Consumes: `kernel.surface.jobs`, `kernel.surface.status()`, `reportText` from `src/kernel/jobs/state.ts`.
- Produces:
  - `statusText(s: Status): string` — what `japa status` prints today: `model: <provider>/<modelId>` (or `none`), `extensions:`, `  <name> — <summary>` per extension, then `errors:` and `  <name>: <error>` lines only when there are errors.
  - `recent(jobs: Job[], now = Date.now()): Job[]` — active jobs plus jobs with `updatedAt > now - 86_400_000`; `board` uses it.
  - In `menu.ts`: `COMMANDS = [{ name: "jobs", description: "Running and recent jobs" }, { name: "status", description: "Model, extensions and errors" }, { name: "settings", description: "Models, schedules and extensions" }]`; `HELP = "Commands:\n" + "/<name> — <description>" lines`; `createMenu(adapter: MessagingAdapter, kernel: KernelContext, jobs: () => Job[]): { command(m: Incoming): Promise<void>; press(m: Incoming): Promise<void> }`.
  - Buttons carry action ids `String(n)` from a counter, mapped in memory to `() => Promise<OutgoingMessage>`; `press` edits `m.messageId` to the view its action returns, or to `This menu expired — send /settings again.` for an unknown id.
  - `/jobs`: `Running and recent jobs:` with one button per `recent(jobs())` job, labelled `<id>. <title> (<status>)`; pressing shows `reportText(job, job.result ?? job.progress ?? "")`. None: `No running or recent jobs.` `/status`: `statusText(kernel.surface.status())`. Any other command (this task includes `settings`): `HELP`.
  - `surface.ts`: `await adapter.commands(COMMANDS)` before `adapter.start`; keeps the latest `kernel.surface.jobs` list; dispatches owner messages with `command` to `command` (after clearing `awaiting`) and with `action` to `press`.

- [ ] **Step 1: Write the failing tests**

```ts
test("the commands are registered when the surface starts", () => expect(fake.commands.at(-1)).toEqual(COMMANDS));

test("/status shows what japa status prints", async () => {
  await fake.receive({ command: "status" });
  expect(fake.sent.at(-1)!.markdown).toBe(statusText(daemon.status()));
  expect(statusText({ model: { provider: "p", modelId: "m" }, extensions: [{ name: "a", summary: "A", provides: [] }],
    errors: [{ name: "b", error: "boom" }] })).toBe("model: p/m\nextensions:\n  a — A\nerrors:\n  b: boom");
});

test("/jobs lists running and recent jobs as buttons; pressing one shows its report", async () => {
  // script: "start sum" → call("job_start", { title: "Sum", brief: "Add" }); wait for the job's report
  await fake.receive({ command: "jobs" });
  const list = fake.sent.at(-1)!;
  expect(list.markdown).toBe("Running and recent jobs:");
  expect(list.buttons![0]![0]!.label).toMatch(/^1\. Sum \(/);
  await fake.press(list.buttons![0]![0]!.label);
  expect(fake.edited.at(-1)).toMatchObject({ messageId: list.id, markdown: expect.stringMatching(/^\[job 1 "Sum" /) });
});

test("/jobs without jobs says so", async () => {
  await fake.receive({ command: "jobs" });
  expect(fake.sent.at(-1)!.markdown).toBe("No running or recent jobs.");
});

test("an unknown command gets the help list and never reaches the CoS", async () => {
  await fake.receive({ command: "start" });
  expect(fake.sent.at(-1)!.markdown).toBe(
    "Commands:\n/jobs — Running and recent jobs\n/status — Model, extensions and errors\n/settings — Models, schedules and extensions");
  await sleep(2000);
  expect(await texts(daemon.root, "user")).toEqual([]);
});

test("a stale button says the menu expired", async () => {
  await fake.receive({ action: "999", messageId: "5" });
  expect(fake.edited.at(-1)).toMatchObject({ messageId: "5", markdown: "This menu expired — send /settings again." });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/messaging-menu.test.ts`
Expected: FAIL — `menu.ts` does not exist.

- [ ] **Step 3: Implement `statusText`, `recent`, `menu.ts` and the dispatch; switch `japa status` to `statusText`**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(messaging): /jobs, /status and help"
```

---

### Task 8: The `/settings` menu

**Files:**
- Modify: `src/kernel/messaging/menu.ts`, `src/kernel/settings-tools.ts`, `src/kernel/install.ts`, `src/kernel/changes.ts`, `src/kernel/contracts.ts` (`MessagingContext`), `src/kernel/boot.ts`, `extensions/schedule/index.ts`
- Test: `test/messaging-menu.test.ts`, `test/helpers.ts` (move `echo(reply)` here from `test/install.test.ts` and import it there)

**Interfaces:**
- Consumes: `createMenu` and the action ids (Task 7), `fake.press` (Task 3).
- Produces:
  - `type Commit = <T>(change: (tx: Tx) => T | Promise<T>) => Promise<T>` in `changes.ts`.
  - `type SettingsDeps = { home: string; settings: Settings; models: Models; extensions: () => JapaExtension[]; changed: () => void }`; `setSetting(deps: SettingsDeps, path: string, value: unknown, commit: Commit, label?: { title?: string; howToUse?: string }): Promise<string>` — today's `settings_set` body, returning its reply (`Set <path>. (change <id>)…` or `Not changed: <reason>`); `settingsTools(deps: SettingsDeps, reconcile: () => Promise<unknown>)` uses it.
  - `rollBackAndLog(home: string, kind: Kind, name: string, to: string | undefined, reconcile: () => Promise<{ errors: LoadError[]; notices: string[] }>, commit: Commit): Promise<string>` in `install.ts` — today's `rollback` tool body, with `reconcile()`'s notices appended after a space; `rollbackTool(home, reconcile)` takes that `reconcile` type and uses it.
  - `MessagingContext` adds `setSetting(path: string, value: unknown): Promise<string>`, `rollback(extension: string): Promise<string>` (`rollBackAndLog(home, "extension", name, undefined, reconcile, commit)`) and `tool(name: string, args: JsonObject): Promise<ToolExecutionResult | undefined>` — the registered tool of that name from `registry.snapshot().tools()`, executed with `{ commit: (change, c) => root.commit(change, c), snapshot: harness.snapshot }` cast to `ToolExecutionApi` (the menu calls only tools that use those two); `undefined` when no tool has the name. Boot's commit is `(change) => root.commit(change, ctx)`.
  - `schedule_list` also returns `details: { id: string; label: string }[]` with `label = \`${text} (${cron ?? local(next)})\``.
- Views (each press edits the pressed message; 8 items per page with a last row `‹` / `›` as needed):
  - `/settings` sends `Settings` with buttons `Models`, `Schedules`, `Extensions`.
  - `Models` → `Which model?` (`CoS`, `Worker`, `Consolidation` → `cos`, `worker`, `consolidation`) → `Choose a provider` (providers with models, in registry order) → `Choose a model` (that provider's `getModels()` ids) → `kernel.messaging.setSetting("models.<role>", { provider, modelId })`'s text.
  - `Schedules` → `Active schedules:` with one button per `details` label (`No schedules.` when none or no `schedule_list`) → `Remove schedule "<label>"?` with `Remove` / `Cancel` → `schedule_remove({ id })`'s text, or `Cancelled.`
  - `Extensions` → `Extensions:` with `<name> (ok)` / `<name> (error)` per `status().extensions` → `<name>: <summary>` (plus `\nError: <error>`) with `Roll back to last known good` / `Cancel` → `kernel.messaging.rollback(name)`'s text, or `Cancelled.`
  - A view that throws shows `Not changed: <message>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a model is set from the menu, logged, and undoable", async () => {
  // kit = testKit({ models: [{ id: "a" }, { id: "b" }] }); models.cos faux/a
  await fake.receive({ command: "settings" });
  for (const label of ["Models", "CoS", "faux", "b"]) await fake.press(label);
  expect(fake.edited.at(-1)!.markdown).toBe("Set models.cos. (change 1)");
  expect(daemon.status().model).toEqual({ provider: "faux", modelId: "b" });
  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe("Undid: Set models.cos");
  expect([...fake.sent, ...fake.edited].flatMap((m) => (m.buttons ?? []).flat()).every((b) => Buffer.byteLength(b.action) <= 64)).toBe(true);
});

test("long lists are paged 8 at a time", async () => {
  // kit with models m1 … m10
  for (const label of ["Models", "CoS", "faux"]) await fake.press(label);   // after /settings
  expect(labels()).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "›"]);
  await fake.press("›");
  expect(labels()).toEqual(["m9", "m10", "‹"]);
});

test("a schedule is removed from the menu after confirmation", async () => {
  await tool(daemon, faux, "schedule_add", { text: "water plants", cron: "0 9 * * *" });
  await fake.receive({ command: "settings" });
  await fake.press("Schedules");
  await fake.press("water plants (0 9 * * *)");
  expect(fake.edited.at(-1)!.markdown).toBe('Remove schedule "water plants (0 9 * * *)"?');
  await fake.press("Remove");
  expect(fake.edited.at(-1)!.markdown).toBe("Removed schedule 1.");
  expect(await tool(daemon, faux, "schedule_list")).toBe("No schedules.");
  expect(await tool(daemon, faux, "changes_list")).toMatch(/Removed schedule "water plants"/);
});

describe("extensions", { timeout: 60_000 }, () => {
  test("an extension is rolled back from the menu after confirmation", async () => {
    // stage and install echo("v1"), daemon.markGood(), stage and install echo("v2")
    await fake.receive({ command: "settings" });
    for (const label of ["Extensions", "echo (ok)", "Roll back to last known good"]) await fake.press(label);
    expect(fake.edited.at(-1)!.markdown).toBe("Rolled back extension echo.");
    expect(await tool(daemon, faux, "echo")).toBe("v1");
    expect(await tool(daemon, faux, "changes_list")).toMatch(/Rolled back extension echo/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/messaging-menu.test.ts`
Expected: FAIL — `/settings` answers the help list.

- [ ] **Step 3: Factor `setSetting` and `rollBackAndLog`; add the `MessagingContext` members, `schedule_list` details and the views**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS — `test/settings-tools.test.ts`, `test/install.test.ts` and `test/schedule.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src extensions/schedule test
git commit -m "feat(messaging): /settings menu for models, schedules and extensions"
```

---

### Task 9: Extensions wait for and request their secrets

**Files:**
- Modify: `src/kernel/contracts.ts` (`KernelContext`), `src/kernel/boot.ts`, `src/kernel/secret-requests.ts`
- Test: `test/secret-requests.test.ts`

**Interfaces:**
- Produces:
  - `addSecretRequest(tx: Tx, name: string, why: string): Promise<boolean>` in `secret-requests.ts` — false when a request for `name` is pending; `secret_request` uses it. `fulfilSecret(...)` returns `Promise<string>`, the secret's name.
  - `KernelContext.secretProvided(name: string): Promise<string>` — resolves with the value the next time a request for `name` is fulfilled; `KernelContext.requestSecret(name: string, why: string): Promise<string>` — commits `addSecretRequest` on the root, then resolves as `secretProvided`. Both reject for a name not in the manifest's `secrets`, with `secret`'s error. Boot keeps the waiters in a `Map<string, ((value: string) => void)[]>` that the surface `fulfil` resolves.

- [ ] **Step 1: Write the failing tests**

```ts
// an extension `svc` with secrets ["svc.token"] whose setup keeps its KernelContext; probe() for fulfil
test("an extension waits for its secret without asking", async () => {
  const value = kernel().secretProvided("svc.token");
  expect((await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending).toEqual([]);
  await tool(daemon, faux, "secret_request", { name: "svc.token", why: "to sync" });
  await surface().secrets.fulfil(pendingId(), "s3cr3t");
  await expect(value).resolves.toBe("s3cr3t");
});

test("an extension asks for its secret and gets it once provided", async () => {
  const value = kernel().requestSecret("svc.token", "to sync");
  await vi.waitFor(async () => expect(await pending()).toMatchObject([{ name: "svc.token", why: "to sync" }]));
  await surface().secrets.fulfil(pendingId(), "s3cr3t");
  await expect(value).resolves.toBe("s3cr3t");
  await vi.waitFor(async () => expect((await texts(daemon.root, "user")).filter((t) => t === "[secret svc.token provided]")).toHaveLength(1));
});

test("an undeclared secret can't be requested", async () => {
  await expect(kernel().requestSecret("other", "x")).rejects.toThrow('Extension svc did not declare secret "other"');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/secret-requests.test.ts`
Expected: FAIL — `secretProvided` is not a function.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(kernel): extensions can wait for and request their secrets"
```

---

### Task 10: Telegram — Bot API client and sending

**Files:**
- Create: `extensions/telegram/index.ts`, `extensions/telegram/api.ts`, `extensions/telegram/html.ts`, `test/telegram-helpers.ts`, `test/telegram.test.ts`

**Interfaces:**
- Consumes: the messaging types (Task 3); `KernelContext.secret`, `secretProvided`, `requestSecret` (Task 9).
- Produces:
  - `backoff(attempt: number): number` = `Math.min(1000 * 2 ** attempt, 60_000)`.
  - `class ApiError extends Error { code: number; retryAfter?: number }` (fields assigned in the constructor).
  - `type BotApi = { once<T>(method: string, params?: object): Promise<T>; call<T>(method: string, params?: object): Promise<T>; download(path: string): Promise<Uint8Array> }`; `botApi(base: string, token: string, signal: AbortSignal): BotApi`. `once`: POST JSON to `${base}/bot${token}/${method}`; `{ ok: false }` throws `ApiError(error_code, description, parameters?.retry_after)`. `call`: `once`, retried after `retryAfter` s on 429 and after `backoff(attempt)` on network errors and codes ≥ 500, rethrowing once the 60 s wait has failed too (8 attempts); other errors rethrow at once; every wait aborts with `signal`. `download`: GET `${base}/file/bot${token}/${path}`.
  - `toHtml(markdown: string): string` — `**x**`/`__x__` → `<b>`, `*x*`/`_x_` (not inside a word) → `<i>`, `~~x~~` → `<s>`, `` `x` `` → `<code>`, fenced blocks → `<pre><code class="language-<lang>">…</code></pre>` (`<pre>…</pre>` without a language), `[t](u)` → `<a href="u">t</a>`, consecutive `> ` lines → `<blockquote>`, `#` headings → `<b>`; `&`, `<`, `>` escaped everywhere else.
  - The default export, `defineJapaExtension({ … })` — name `telegram`; summary `Chat with japa on Telegram. To connect, ask the user for the secret telegram.botToken (a bot token from @BotFather); the bot then tells them their Telegram user id, which goes in settings extensions.telegram.owner.`; `secrets: ["telegram.botToken"]`; `setup` keeps the `KernelContext`; `provides: { messaging: [adapter] }`. Requests go to `https://api.telegram.org`.
  - The adapter: `name: "telegram"`, `maxMessageChars: 4096`. Calls go through `call` on the API for the current token (`kernel.secret("telegram.botToken")`, cached until a 401; `Telegram is not connected` when absent), with the signal of the `AbortController` that `start` creates and dispose aborts. `send` → `sendMessage { chat_id, text: toHtml(md), parse_mode: "HTML", reply_markup?: { inline_keyboard: [[{ text: label, callback_data: action }]] } }`, returning `String(message_id)`; a 400 whose description contains `can't parse entities` is sent once more with `text: md` and no `parse_mode`; an action over 64 bytes (`Buffer.byteLength`) throws `Button action over 64 bytes: <action>` before any call. `edit` → `editMessageText { chat_id, message_id: Number(id), … }` with the same fallback. `delete` → `deleteMessage`. `typing` → `sendChatAction { chat_id, action: "typing" }`. `commands(list)` stores the list (registered in Task 11).
  - In `test/telegram-helpers.ts`: `fakeBotApi(): Promise<{ calls: { token: string; method: string; params: any; at: number }[]; push(...updates: object[]): void; replayOnce(): void; fail(method: string, status: number, body: object, times?: number): void; file(path: string, data: Uint8Array): void; close(): Promise<void> }>` — a `node:http` server; `vi.stubGlobal("fetch", …)` sends `https://api.telegram.org/…` requests to it (other URLs to the real `fetch`), `close()` unstubs. `getUpdates` forgets queued updates below `offset` and returns the rest, at once when there are any, otherwise after 200 ms with `[]`; after `replayOnce()` the next call returns the last non-empty batch again; `sendMessage` returns increasing `message_id`s; `getFile` returns `{ file_path: <file_id> }`. `kernelStub(token?: string)` → `{ kernel, requested: { name; why }[], provide(token: string): void }`. `startTelegram(stub, receive?)` runs the default export's `setup(stub.kernel)` and `adapter.start`, returning `{ adapter, received: Incoming[], stop }`. Tests read `sends()` / `offsets()`: the `sendMessage` params / `getUpdates` offsets in `calls`.

- [ ] **Step 1: Write the failing tests**

```ts
test.each([
  ["**bold**, *it* and ~~gone~~", "<b>bold</b>, <i>it</i> and <s>gone</s>"],
  ["a < b & c > d", "a &lt; b &amp; c &gt; d"],
  ["use `x<y`", "use <code>x&lt;y</code>"],
  ["```ts\nif (a < b) {}\n```", '<pre><code class="language-ts">if (a &lt; b) {}</code></pre>'],
  ["[site](https://e.com/?a=1&b=2)", '<a href="https://e.com/?a=1&amp;b=2">site</a>'],
  ["> quoted\n> more", "<blockquote>quoted\nmore</blockquote>"],
  ["# Title", "<b>Title</b>"],
  ["snake_case_name stays", "snake_case_name stays"],
])("toHtml(%j)", (md, html) => expect(toHtml(md)).toBe(html));

test("backoff starts at 1 s and doubles to 60 s", () =>
  expect([0, 1, 2, 5, 6, 9].map(backoff)).toEqual([1000, 2000, 4000, 32000, 60000, 60000]));

test("send posts HTML with an inline keyboard and returns the message id", async () => {
  expect(await adapter.send("42", { markdown: "**hi**", buttons: [[{ label: "A", action: "1" }]] })).toBe("1");
  expect(sends()).toEqual([{ chat_id: "42", text: "<b>hi</b>", parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "1" }]] } }]);
});

test("HTML Telegram can't parse is resent as plain text", async () => {
  fake.fail("sendMessage", 400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities: x" }, 1);
  await adapter.send("42", { markdown: "**hi**" });
  expect(sends().at(-1)).toEqual({ chat_id: "42", text: "**hi**" });
});

test("without a token, sending fails", async () => {
  // kernelStub(undefined)
  await expect(adapter.send("42", { markdown: "x" })).rejects.toThrow("Telegram is not connected");
});

test("a button action over 64 bytes is rejected before sending", async () => {
  await expect(adapter.send("42", { markdown: "x", buttons: [[{ label: "A", action: "a".repeat(65) }]] })).rejects.toThrow("over 64 bytes");
  expect(sends()).toEqual([]);
});

test("a 429 waits retry_after seconds; a 5xx waits 1 s", async () => {
  fake.fail("sendMessage", 429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }, 1);
  fake.fail("deleteMessage", 502, { ok: false, error_code: 502, description: "Bad Gateway" }, 1);
  // both succeed; each pair of calls is at least 1000 ms apart (`at`)
});

test("edit, delete and typing call their methods", async () => {
  // editMessageText { chat_id: "42", message_id: 7, text: "<i>x</i>", parse_mode: "HTML" }, deleteMessage { chat_id: "42", message_id: 7 },
  // sendChatAction { chat_id: "42", action: "typing" }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/telegram.test.ts`
Expected: FAIL — `extensions/telegram` does not exist.

- [ ] **Step 3: Implement `api.ts`, `html.ts` and the adapter's sending side in `index.ts` (`start` returns a dispose that aborts; polling comes in Task 11)**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS (the packaged extension loads dormant in every test daemon).

- [ ] **Step 5: Commit**

```bash
git add extensions/telegram test
git commit -m "feat(telegram): Bot API client and sending"
```

---

### Task 11: Telegram — receiving

**Files:**
- Create: `extensions/telegram/updates.ts`
- Modify: `extensions/telegram/index.ts`
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `botApi`, `backoff`, `ApiError` (Task 10); `secretProvided`, `requestSecret` (Task 9).
- Produces:
  - `type Update` (the fields used: `update_id`, `message { message_id, from { id }, chat { id, type }, text?, entities?, caption?, photo?, document?, media_group_id? }`, `callback_query { id, from { id }, message { message_id, chat { id, type } }, data }`) and `parseUpdate(update: Update, api: BotApi): Promise<Incoming | string | undefined>` in `updates.ts` — an `Incoming`; a reply to send back (string); or undefined (not a private chat, or another update kind). Ids are strings: `chat`, `user` (`from.id`), `messageId`, `id` (`update_id`). A text starting with a `bot_command` entity at offset 0 is `command` (its name without `/` and `@<bot>`); `caption` is `text`. `photo` uses its last (largest) size, an image `document` its `mime_type`; `file_size > 20 * 1024 * 1024` → `That file is too large: Telegram bots can only download files up to 20 MB.`; else `getFile` + `download` → `images: [{ data, mimeType }]` (`image/jpeg` for photos). Any other message → `I can only read text and images here.` A `callback_query` → `{ chat, user, messageId: message.message_id, id, action: data }`.
  - `start(ctx)` returns its dispose at once and runs the loop: token = `secret(NAME) ?? secretProvided(NAME)`; `setMyCommands({ commands: list.map((c) => ({ command: c.name, description: c.description })) })`; then `once("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] })`. Each update in order: a `callback_query` is answered first (`answerCallbackQuery { callback_query_id }`, errors ignored); its `Incoming` goes to `await ctx.receive`, a reply string to `send(chat, { markdown })`; an error is logged `telegram: <message>`. Then `offset = last update_id + 1`. A 401 drops the API, sets token = `requestSecret(NAME, "Telegram rejected the bot token. Send a new one from @BotFather.")` and registers the commands again; other errors wait `backoff(attempt++)`, reset after a success. Dispose aborts and does not wait for the loop.

- [ ] **Step 1: Write the failing tests**

```ts
const text = (id: number, t: string, extra = {}) => ({ update_id: id, message: { message_id: id - 95, from: { id: 42 }, chat: { id: 42, type: "private" }, text: t, ...extra } });

test("updates are confirmed only after receive has taken them", async () => {
  // startTelegram with a receive that resolves only when `go()` is called
  fake.push(text(100, "hi"));
  await vi.waitFor(() => expect(received).toHaveLength(1));
  await sleep(300);
  expect(offsets()).not.toContain(101);
  go();
  await vi.waitFor(() => expect(offsets()).toContain(101));
});

test("texts, commands and button presses become Incoming messages", async () => {
  fake.push(text(100, "hi"), text(101, "/jobs@japa_bot", { entities: [{ type: "bot_command", offset: 0, length: 14 }] }),
    { update_id: 102, callback_query: { id: "cb1", from: { id: 42 }, message: { message_id: 7, chat: { id: 42, type: "private" } }, data: "3" } });
  await vi.waitFor(() => expect(received).toEqual([
    { chat: "42", user: "42", messageId: "5", id: "100", text: "hi" },
    { chat: "42", user: "42", messageId: "6", id: "101", command: "jobs" },
    { chat: "42", user: "42", messageId: "7", id: "102", action: "3" }]));
  expect(fake.calls.find((c) => c.method === "answerCallbackQuery")!.params).toEqual({ callback_query_id: "cb1" });
});

test("a photo is read at its largest size with its caption; an album is one Incoming per photo", async () => {
  // two updates with media_group_id "g": photo [{ file_id: "s", file_size: 10 }, { file_id: "l", file_size: 100 }], the first with caption "trip"
  expect(received[0]).toMatchObject({ text: "trip", images: [{ data: L_BYTES, mimeType: "image/jpeg" }] });
  expect(received).toHaveLength(2);
  expect(fake.calls.filter((c) => c.method === "getFile").map((c) => c.params.file_id)).toEqual(["l", "l2"]);
});

test("an image document is read with its type; other documents and messages are refused", async () => {
  // document { file_id: "d", mime_type: "image/png" } → images [{ mimeType: "image/png" }];
  // document application/pdf and a sticker → sendMessage "I can only read text and images here." each, nothing received
});

test("a file over 20 MB is refused without downloading", async () => {
  // photo with file_size 20 * 1024 * 1024 + 1
  expect(sends().at(-1)!.text).toBe("That file is too large: Telegram bots can only download files up to 20 MB.");
  expect(fake.calls.some((c) => c.method === "getFile")).toBe(false);
});

test("group chats are ignored", async () => { /* chat.type "group" → nothing received, nothing sent */ });

test("a 401 stops polling and asks for a new token", async () => {
  // kernelStub("BAD"); fake.fail("getUpdates", 401, { ok: false, error_code: 401, description: "Unauthorized" })
  await vi.waitFor(() => expect(stub.requested).toEqual([{ name: "telegram.botToken",
    why: "Telegram rejected the bot token. Send a new one from @BotFather." }]));
  const polls = fake.calls.filter((c) => c.method === "getUpdates").length;
  await sleep(500);
  expect(fake.calls.filter((c) => c.method === "getUpdates")).toHaveLength(polls);
  stub.provide("NEW");
  await vi.waitFor(() => expect(fake.calls.at(-1)!.token).toBe("NEW"));
});

test("without a token the bot waits, asking nothing, and starts once it is provided", async () => {
  // kernelStub(undefined); adapter.commands(COMMANDS) before start
  await sleep(300);
  expect(fake.calls).toEqual([]);
  expect(stub.requested).toEqual([]);
  stub.provide("T");
  await vi.waitFor(() => expect(fake.calls.map((c) => c.method).slice(0, 2)).toEqual(["setMyCommands", "getUpdates"]));
});

test("polling carries on after server errors", async () => {
  fake.fail("getUpdates", 500, { ok: false, error_code: 500, description: "Internal" }, 1);
  fake.push(text(100, "hi"));
  await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
});

test("a default install has Telegram dormant: no error, no pending secret request", async () => {
  const { daemon } = await bootTest();
  expect(daemon.status().extensions.map((e) => e.name)).toContain("telegram");
  expect(daemon.status().errors).toEqual([]);
  expect((await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending).toEqual([]);
});

test("a replayed update_id reaches the CoS once", async () => {
  // <dir>/telegram.botToken written first; bootTest({ secrets: { adapter: "file", dir }, extensions: { telegram: { owner: "42" } } })
  // (the packaged extension); push text(7, "hi"); once it is confirmed, fake.replayOnce()
  await waitFor(async () => (await texts(daemon.root, "user")).includes("hi"));
  await sleep(2000);
  expect((await texts(daemon.root, "user")).filter((t) => t === "hi")).toHaveLength(1);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/telegram.test.ts`
Expected: FAIL — nothing is polled.

- [ ] **Step 3: Implement `parseUpdate` and the polling loop**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/telegram test
git commit -m "feat(telegram): long polling, content parsing, token handling"
```

---

### Task 12: Content and docs

**Files:**
- Modify: `skills/building-extensions/SKILL.md`, `docs/superpowers/specs/2026-10-07-japa-design.md`, `README.md`
- Test: `test/content.test.ts`

**Interfaces:**
- Consumes: everything above; `CONTRACTS` from `src/kernel/contracts.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test("the building-extensions skill covers every core contract", () => {
  const skill = readFileSync(join(packageRoot, "skills/building-extensions/SKILL.md"), "utf8");
  for (const name of CONTRACTS.keys()) expect([name, skill.includes(`**${name}**`)]).toEqual([name, true]);
  for (const text of ["root.replies", "secretProvided", "requestSecret"]) expect([text, skill.includes(text)]).toEqual([text, true]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest --run test/content.test.ts`
Expected: FAIL — no `**messaging**`.

- [ ] **Step 3: Write the content**

- `building-extensions`: the **surface** bullet gets `root.submit(input, mode?, origin?)` (text or text and image parts; pass `{ surface: <name>, chat?, id? }` so replies route back and an `id` deduplicates) and `root.replies(listener, after?)` (finished replies with their origin and a cursor to persist). A **messaging** bullet and a short `## Messaging adapters` section: the adapter interface; what core provides (owner check and `extensions.<name>.owner`, `/jobs` `/status` `/settings`, secrets, routing, merging, images, splitting, typing); transport only: convert markdown, register commands, resolve `receive` before confirming upstream, a platform-unique `Incoming.id`, only private chats, a proactive chat is the owner's user id, reject actions over 64 bytes; the test pattern (call `adapter.start({ receive })` with a recording `receive`, replace `fetch` with `vi.stubGlobal`, assert the requests). The `KernelContext` section adds `secretProvided(name)` and `requestSecret(name, why)` for a key the extension can't work without.
- Main spec: §1 non-goals drop "Messaging surfaces (Slack/Telegram/iMessage)"; §2 and §4.2 say eight contracts and add the `messaging` row (runtime, many, chat platforms, `telegram`); §4.1 `surface` gets the origin, `replies` and the secrets rule "…as masked prompts, or, where the platform cannot mask input, by deleting the message holding the secret as soon as it is read"; a `messaging` subsection with spec §4's interface and a pointer to the messaging spec; `KernelContext` gains `secretProvided` / `requestSecret`; the boot activation step ends `surface`, then `messaging`; §11.1 adds the `telegram` row (messaging: Bot API long polling, text and images in, commands and settings menu).
- README: a "Telegram" section: create a bot with @BotFather; in `japa chat` ask the CoS to connect Telegram and paste the token at the masked prompt; message the bot, which answers with your user id; tell the CoS; then `/jobs`, `/status`, `/settings`, photos (saved under `~/.japa/attachments/`), and secrets answered in the chat (the message is deleted at once).

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills docs/superpowers/specs/2026-10-07-japa-design.md README.md test
git commit -m "docs: messaging contract, Telegram, origins"
```
