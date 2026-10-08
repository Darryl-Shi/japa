# japa — messaging gateways and Telegram

Date: 2026-10-08
Status: Draft for review
Extends: `2026-10-07-japa-design.md` (the "main spec")

## 1. Purpose

japa runs on an always-on home server or VPS. Today the only way to reach the
CoS is `japa chat` over the local socket, so nothing reaches the user away
from the terminal — not schedule results, not job reports. This spec adds:

1. **Origin routing** in the core `surface` contract: every root turn knows
   which surface (and chat) started it, or that it is proactive.
2. A core **`messaging` contract** for chat platforms. Platforms supply a thin
   transport adapter; the kernel implements every shared messaging feature
   once (commands, settings menu, secrets, owner check, routing, images).
3. **`extensions/telegram`**, the first messaging adapter: two-way text and
   images in, over Bot API long polling.

Success: from a phone, the user chats with the same single CoS thread, gets
proactive messages (schedules, job reports), uses `/jobs`, `/status` and
`/settings`, sends photos, and can finish a secret request — with no
inbound port on the server.

### Changes to the main spec

- §1 Non-goals: remove "Messaging surfaces (Slack/Telegram/iMessage)".
  ("Built-in OAuth flows" is lifted by the later `google` spec, not this one.)
- §4.1 `surface`: add origin (§3 below).
- §4: add the `messaging` contract (§4 below) as a core runtime contract.
- §4.1 `surface`: the rule "every interactive surface must render pending
  secret requests as masked prompts" becomes "…as masked prompts, or, where
  the platform cannot mask input, by deleting the message holding the secret
  as soon as it is read" (§5.5).
- §11.1: add `telegram` to the default extensions.

### Out of scope

Files and images out (the CoS sending attachments), non-image files in, voice
messages, a `/stop` command, an undo button on change reports, group chats,
more than one owner, webhook delivery, other platforms. A dynamic context
reset threshold (instead of the fixed `context.resetTokens`) is a separate
kernel item.

## 2. Architecture

```
kernel
 ├─ surface contract (changed): submit carries an origin; new root.replies stream with origins
 ├─ messaging contract (new, runtime, many): platform transport adapters
 └─ messaging surface (new): one generic surface per registered adapter, holding all shared behaviour
extensions/telegram → provides { messaging: [telegram] }      transport only
extensions/gateway  → submits with origin { surface: "gateway" }; otherwise unchanged
```

Contract activation order becomes
`provider, environment, tool, trigger, surface, messaging`.

## 3. Origin routing (core `surface` contract)

```ts
type Origin = { surface: string; chat?: string } | "proactive";

SurfaceContext.root.submit(input: UserInput, mode?: "steer" | "followUp", origin?: { surface: string; chat?: string; id?: string })
SurfaceContext.root.replies(listener: (r: Reply) => void, after?: string): Promise<{ stop(): Promise<void> }>
type Reply = { cursor: string; origin: Origin; text: string };
```

- `UserInput` is Pi Durable's user content (text, or text and image parts),
  so `submit` accepts images without a new mechanism. A plain string still
  works.
- **Encoding.** The origin lives in the submission's `requestId`:
  `surface:<surface>:<chat>:<id>` (the `id`, when given, also deduplicates —
  Telegram passes its `update_id`). Kernel-made inputs keep their existing
  prefixes (`trigger:`, `report:`, `job:`, `secret:`, `rollback:`,
  `rollback-none:`, `safe-mode:`); all of these are **proactive**. Inputs
  without a `requestId` (old entries) are treated as `{ surface: "gateway" }`.
- **Turns.** A run's origin is the origin of the input that started it. An
  input that steers or follows up a running turn takes over the origin for the
  rest of that run, so the reply goes where the latest message came from.
- **Replies.** `root.replies` delivers each finished assistant message (text
  only — no streaming, no tool calls) with its turn's origin, in order. `after`
  is a cursor from an earlier `Reply`; delivery resumes after it, so a surface
  that persists its cursor gets every reply at least once across restarts.
- **Who shows what.** A messaging surface shows replies whose origin is its
  own surface (and chat) plus every proactive reply. `japa chat` keeps showing
  the whole thread through `root.events`, unchanged.

## 4. The `messaging` contract

```ts
interface MessagingAdapter {
  name: string;                         // "telegram"; also the surface name in origins
  maxMessageChars: number;              // outgoing limit per message (Telegram: 4096); inputs are not capped
  start(ctx: MessagingAdapterContext): Promise<Dispose>;
  send(chat: string, m: OutgoingMessage): Promise<string>;           // returns the message id
  edit(chat: string, messageId: string, m: OutgoingMessage): Promise<void>;
  delete(chat: string, messageId: string): Promise<void>;
  typing(chat: string): Promise<void>;  // shows "typing…" for a few seconds
  commands(list: { name: string; description: string }[]): Promise<void>;  // registers slash commands
}
interface MessagingAdapterContext {
  receive(m: Incoming): Promise<void>;  // the adapter calls this for each incoming message or button press
}
type Incoming = {
  chat: string; user: string; messageId: string; id: string;   // id: platform-unique, used for dedup
  text?: string;
  images?: { data: Uint8Array; mimeType: string }[];
  command?: string;                     // "jobs" for "/jobs"
  action?: string;                      // a pressed button's action
};
type OutgoingMessage = { markdown: string; buttons?: { label: string; action: string }[][] };
```

The adapter converts `markdown` to the platform's format. It knows nothing
about japa features. Contract docs (agent-facing): "A chat platform the user
talks to the CoS through. Implement only transport; japa provides commands,
settings, secrets, routing and images."

## 5. The core messaging surface

The kernel starts one messaging surface per active adapter. All behaviour
below is written once, in `src/kernel/messaging/`, and tested against a fake
adapter.

### 5.1 Owner

Settings: `extensions.<adapter>.owner` (string user id), added to every
messaging adapter's settings schema by the kernel. Until it is set, and for
any other user, the surface answers each message with "Not authorized. Your
<adapter> user id is N." and otherwise ignores it. Only private chats
with the owner are handled.

### 5.2 Input

- Text and images go to `root.submit` with the surface's origin; when the
  CoS is busy, the mode is `followUp`.
- **Merging.** Consecutive owner messages arriving within 1.5 s of each other
  are merged into one input (text joined by blank lines, images collected).
  This covers a long paste the platform split and a photo album.
- **Images.** Each image is saved to `~/.japa/attachments/<date>/<id>.<ext>`
  (ignored by git) and passed as an image part, together with a text note
  holding its path, so the CoS can hand it to a job. If the CoS model has no
  image input, only the path note is sent, plus "(this model cannot see
  images)".

### 5.3 Output

- The surface subscribes to `root.replies` from its persisted cursor and
  sends each matching reply, split at `maxMessageChars` (on paragraph, then
  line, then word boundaries; code blocks are closed and reopened across a
  split).
- While a run of its own origin is active, it calls `typing` every 4 s.
- A send that still fails after retries (§6) is logged and skipped; the
  cursor moves on, and the CoS turn is unaffected.

### 5.4 Commands

Registered with `commands()` on start:

| Command | Does |
|---------|------|
| `/jobs` | Lists running and recent jobs (the `jobs` stream) as buttons; pressing one shows its status and latest report. |
| `/status` | The same content as `japa status`: CoS model, extensions, errors. |
| `/settings` | The settings menu (§5.6). |

Unknown commands get a short help list. Commands never reach the CoS.

### 5.5 Secrets

When a secret request is pending, the surface shows it ("japa needs
`<name>`: <reason>. Send it as your next message; I'll delete it at once.").
The owner's next text message fulfils the oldest pending request through
`secrets.fulfil` and is deleted straight away; it is never submitted to the
CoS or merged. If deleting fails, the secret is still stored and the surface
says "Couldn't delete your message — please delete it yourself." A command
cancels this state (the request stays pending).

### 5.6 Settings menu

A button menu edited in place. Each change goes through the same code path as
the CoS's `settings_set` / `change_undo` / schedule tools, so it is validated
and logged in `japa.changes` (undoable).

- **Models** → choose CoS / worker / consolidation → a paged list of the
  registered models (provider, then model) → set.
- **Schedules** → active schedules → remove (asks for confirmation).
- **Extensions** → installed extensions with their status → roll back to the
  last known good version (asks for confirmation; restart notice as in
  `japa rollback`).

Errors come back as a message: "Not changed: <reason>". Button actions are
short ids (≤ 64 bytes) mapped to menu state held in memory; a stale button
(after a restart) answers "This menu expired — send /settings again."

## 6. Telegram adapter (`extensions/telegram`)

Plain `fetch` against the Bot API; no new dependencies.

- **Setup.** In `japa chat`, the user asks the CoS to connect Telegram. The
  extension's secret `telegram.botToken` is missing, so it raises a secret
  request (shown masked in the TUI); the token comes from @BotFather. Once
  started, the bot answers the user with their id (§5.1); the user tells the
  CoS, which sets `extensions.telegram.owner`.
- **Receiving.** `getUpdates` long polling (50 s timeout). Passing the next
  offset confirms earlier updates on Telegram's side, so the adapter keeps no
  state of its own; it confirms a batch only after handing it to `receive`.
  `Incoming.id` is the `update_id`, which the kernel puts in the `requestId`,
  so a batch replayed after a crash is admitted once.
- **Content.** Text, `photo` (largest size), image `document`s, captions (as
  text), and albums (`media_group_id`; merged by §5.2). Files come from
  `getFile`; over the Bot API's 20 MB limit, the bot replies that the file is
  too large. Other message types get "I can only read text and images here."
- **Commands and buttons.** `setMyCommands`; inline keyboards with
  `callback_data` = action (rejected if over 64 bytes); `answerCallbackQuery`
  on every press.
- **Formatting.** Markdown → Telegram HTML subset (`b i s u code pre a
  blockquote`), escaping everything else. If Telegram rejects the HTML (400
  "can't parse entities"), the message is resent as plain text.
- **Limits and errors.** `maxMessageChars` 4096. Honours `429 retry_after`;
  retries network and 5xx errors with backoff (1 s doubling to 60 s); polling
  never stops on errors. A 401 (bad token) stops polling and raises a new
  secret request.

## 7. Error handling

- Adapter `start` failures and repeated throws are handled by the main spec's
  §10.4 (status error, auto-rollback, CoS told).
- Send failures never fail a CoS turn (§5.3).
- Secret deletion failure: §5.5.
- Settings actions: validated like `settings_set`; errors shown, nothing
  changed.
- Images with a non-vision model: §5.2.

## 8. Testing

vitest, following existing patterns (fake model, scratch `JAPA_HOME`).

- **Origin routing:** requestId encoding; origins of gateway input, triggers,
  job reports, secrets; steer/follow-up taking over a run's origin; `replies`
  ordering and resuming from a cursor; old inputs without a requestId.
- **Messaging surface** (fake in-memory adapter): owner check and the
  not-authorized reply; own and proactive replies delivered, `japa chat`
  replies not; splitting (including code blocks); merging within 1.5 s;
  typing while running; each command; settings menu flows (model set, schedule
  removed, extension rolled back, logged in changes, stale buttons); secret
  accept-and-delete, deletion failure, cancel by command; images saved and
  sent as image parts, and the non-vision fallback; send failure skipped.
- **Gateway:** submits with its origin; still shows the full thread.
- **Telegram** (fake Bot API on a local HTTP server): offset confirmed only
  after `receive`; duplicate `update_id` admitted once; photo, document, caption and
  album parsing; 20 MB refusal; HTML fallback to plain text; `429
  retry_after`; 401 raising a secret request; long `callback_data` rejected.
- **Content:** the `building-extensions` skill gains a `messaging` section
  (adapter interface, what core provides, the fake-adapter test pattern).
