# japa — secret prompts, chat markdown, and /update

Date: 2026-10-09
Status: Draft for review
Amends: `2026-10-08-japa-messaging-telegram-design.md` (the "messaging spec") and
`2026-10-08-japa-install-design.md` (the "install spec", §5 updating)

## 1. Purpose

Three independent changes to the messaging surface. Each can ship on its own; build them in this order.

**A. Secret requests take the owner's next text.** On a messaging adapter, the oldest pending `secret_request` is
announced and the owner's next text is taken as the secret (`src/kernel/messaging/surface.ts`, `awaiting` /
`announce`). A message meant for the CoS can be swallowed as a secret, and only one request is asked at a time. The
mechanism is kernel-wide (every messaging adapter gets it); `japa chat` already has its own masked prompt.

**B. Telegram markdown breaks.** `extensions/telegram/html.ts` converts markdown with regexes. Overlapping emphasis
produces misnested tags (`***both***` → `<b><i>both</b></i>`); Telegram rejects the HTML with "can't parse entities"
and the whole reply falls back to raw markdown. Tables, task lists and nested lists are passed through as text.

**C. Updating needs a terminal.** `japa update` exists only as a CLI. The owner can't update japa from chat.

## 2. Part A — secret prompts

### 2.1 Behaviour

Every pending secret request gets its own **prompt**: a message to the owner that opens the platform's native
"reply here" input, with a placeholder naming the secret. Only a **reply to a prompt** fulfils that request. Every
other text goes to the CoS (or to a menu screen waiting for a value), as usual. All pending requests are prompted at
once and can be answered in any order.

Each prompt is followed by a short **Decline** message with a `[Decline]` button (Telegram allows either a
force-reply or inline buttons on one message, not both). Declining withdraws the request on every surface.

### 2.2 Contract changes (`src/kernel/contracts.ts`)

- `OutgoingMessage` gains `input?: { placeholder: string }`: show this message with the platform's reply input,
  pre-filled with `placeholder` as a hint. An adapter without such a UI ignores it (the prompt text still says
  "reply to this message").
- `Incoming` gains `replyTo?: string`: the id of the message this one replies to.
- `SurfaceContext.secrets` gains `decline(requestId: string): Promise<void>`: removes the request and tells the CoS
  `[secret <name> declined]` (submitted with requestId `secret-declined:<id>`, so a repeat is a no-op); throws for
  an unknown request. A sign-in's `<extension>.authorize` request is not reported this way: declining it aborts the
  `connect` flow, which ends with `sign-in cancelled` through its usual report.
- `requestSecret` / `secretProvided` waiters are not resolved or rejected by a decline: they keep waiting for a value
  (e.g. Telegram's own bot token, which only `japa setup` or `japa chat` can then provide).

### 2.3 Telegram (`extensions/telegram`)

- `input` → `reply_markup: { force_reply: true, input_field_placeholder }`. Telegram caps the placeholder at 64
  characters; the adapter truncates with `…`. A message with both `input` and `buttons` is a programming error and
  throws.
- `parseUpdate` sets `replyTo` from `message.reply_to_message.message_id`.

### 2.4 Surface (`src/kernel/messaging/surface.ts`)

- `MessagingDoc` gains `prompts: Record<string, { requestId: string; prompt: string; decline: string; chat: string }[]>`
  per adapter: the prompt and decline message ids for each prompted request, and `promptHistory: Record<string,
  string[]>`: the last 50 prompt message ids this adapter sent (§2.5).
- **Sending.** When the pending list changes, and when the owner is first known (an owner message arrives or
  `extensions.<adapter>.owner` is set), every pending request without a saved prompt is prompted: the prompt,
  `japa needs \`<name>\`: <why>. Reply to this message with it; I'll delete your reply at once.`, with
  `input: { placeholder: "Paste <name>" }`; then the decline message, `Don't want to provide <name>?` with
  `[Decline]`. The ids are saved before anything else happens, so a restart neither re-sends nor forgets them.
- **Answering.** An owner text whose `replyTo` is a saved prompt's id fulfils that request through
  `secrets.fulfil(requestId, text, by)`; the reply is deleted at once (failing that, the owner is asked to delete it,
  as now), then the prompt and the decline message are deleted. A reply takes precedence over a menu screen waiting
  for a value.
- **Gone elsewhere.** When a request leaves the pending list for any reason (fulfilled in `japa chat` or the settings
  menu, declined anywhere, withdrawn by the CoS), its prompt and decline message are deleted and the entry dropped.
- **Decline.** Pressing `[Decline]` calls `secrets.decline` (an unknown request — already gone — just deletes the two
  messages). Decline buttons carry the request id and are not tied to the menu's per-run token, so they keep working
  after a restart.
- **Removed:** `awaiting`, `announce`, and the interplay where a menu input held back the secret request. The menu's
  own `secretInput` handling (a `/settings → Set` screen waiting for a secret across a restart) is unchanged.

### 2.5 Safety cases

- **A reply to a prompt that is no longer pending** (the request was fulfilled or declined elsewhere while the owner
  typed): `replyTo` is in `promptHistory` but not in `prompts`. The text is treated as a secret it can't use: deleted
  at once, never submitted, and the owner is told `That request is no longer pending.`
- **Re-delivery** of a reply that already fulfilled a request is dropped and deleted again via the existing
  `fulfilledBy` record.
- **No owner yet:** nothing is prompted; prompts go out once the owner is known.

### 2.6 `japa chat` (`extensions/gateway`)

The masked prompt is unchanged, plus Ctrl-X: decline the request shown (new protocol message
`{ type: "decline"; requestId }`). Esc still only hides the prompt.

### 2.7 Out of scope

`/settings → Set` screens keep their "next text, expires in 10 minutes" input.

### 2.8 Testing

- `test/messaging.test.ts` (fake adapter): a reply fulfils and both messages are deleted; plain text goes to the CoS
  while a request is pending; three requests answered out of order; prompts survive a restart (no re-send, reply
  still works); decline tells the CoS and deletes the messages; fulfilling in `japa chat` deletes the prompt; a reply
  to a stale prompt is deleted and never submitted; a reply wins over a waiting menu input; no owner → no prompts.
- `test/secret-requests.test.ts`: `decline` removes the request and reports it once; declining an `.authorize`
  request ends `connect` with `sign-in cancelled`; a `requestSecret` waiter stays pending.
- `test/telegram.test.ts`: `force_reply` + truncated placeholder are sent; `input` with `buttons` throws; `replyTo`
  is parsed.
- `test/gateway.test.ts`: Ctrl-X sends `decline`.

## 3. Part B — markdown on Telegram

### 3.1 Converter

`toHtml` in `extensions/telegram/html.ts` is rewritten on `marked`'s lexer (`marked` 18.0.11, already installed by
`@earendil-works/pi-tui`; added as a direct dependency at that exact version). A small renderer walks the tokens and
emits only Telegram's HTML subset, opening and closing tags as a stack, so output is always well-nested. GFM is on
(tables, task lists, strikethrough, autolinks).

| Markdown | Telegram HTML |
|---|---|
| `**b**` / `__b__`, `*i*` / `_i_`, `~~s~~` | `<b>`, `<i>`, `<s>`, nested as written |
| `` `code` `` | `<code>` |
| fenced block with language / without | `<pre><code class="language-x">` / `<pre>` |
| heading (any level) | `<b>text</b>` on its own line |
| link, autolink | `<a href="…">` |
| image | `<a href="src">alt or src</a>` |
| blockquote | `<blockquote>`; `<blockquote expandable>` when over 10 lines |
| bullet / ordered list, nested | `• ` / `1. ` lines, nested items indented two spaces per level |
| task item | `☐ ` / `☑ ` |
| table | `<pre>` with columns padded to equal width, a `─` rule under the header; cell markdown stripped to text |
| thematic break | `———` |
| raw HTML (block or inline) | escaped, shown as text |
| `\|\|text\|\|` | `<tg-spoiler>` (a marked inline extension) |

Paragraphs are separated by a blank line; text is escaped (`& < >`), attributes also `"`. `snake_case_names` stay
literal (marked's intraword `_` rule).

### 3.2 Fallback

When Telegram still answers 400 "can't parse entities", the part is re-sent as **plain text**: `toPlain(markdown)`,
the same token walk emitting no tags (markers dropped, links as `label (url)`), instead of raw markdown.

### 3.3 Length

`splitMessage` keeps cutting the markdown before conversion. Telegram's 4096 limit counts text after entity parsing,
so tags don't count; padded tables can grow a part. If the rendered visible text of a part exceeds 4096, the adapter
re-splits that part's markdown at half the size and sends the pieces.

### 3.4 Prompt nudge

`src/kernel/identity.md` gains one line: replies render as Markdown on chat surfaces; tables show as monospace, so
keep them narrow.

### 3.5 Testing

- `test/telegram.test.ts`: every existing `toHtml` case still passes; new cases for `***both***`, nested emphasis,
  unclosed `**`, nested and ordered lists, task items, a table (alignment, header rule, escaping inside cells), raw
  `<script>`, spoilers, long blockquote → `expandable`, images.
- Fake Bot API: a "can't parse entities" 400 re-sends `toPlain` text without `parse_mode`; an over-long rendered
  part is sent as two messages.

## 4. Part C — /update from chat

### 4.1 Flow

`/update` joins `COMMANDS` (`src/kernel/messaging/menu/index.ts`), so every messaging adapter has it; owner only,
like all commands. A new screen file `src/kernel/messaging/menu/update.ts` (scope `"u"` in the nav) handles it.

1. **Check.** `/update` shows `Checking…`, then runs the check (§4.3). Up to date: `✓ japa is up to date (abc1234)`.
   Otherwise: `N new commits (abc1234 → def5678)`, the commit list (newest 20, `+M more`), and
   `japa will restart; K jobs are active.`, with `[Update now]` `[Cancel]`. A check failure shows `✗ <reason>`.
2. **Start.** `Update now` edits the screen to `Updating… japa will restart and report back here.` and starts the
   detached update (§4.4) targeting the checked commit (`--to <sha>`, so what runs is what was shown).
3. **Report.** Whichever daemon is running when the update finishes sends the result to the chat that asked (§4.5):
   - `✓ Updated abc1234 → def5678` + the commit summary + what's new (§4.6), with `[Roll back]`;
   - `✓ Updated … — restart \`japa daemon\` to apply` for a foreground daemon;
   - `✗ update failed at <step>: <summary>; still on abc1234` (+ up to 10 lines of output in a code block);
   - `✓ japa is up to date (abc1234)` if it became current meanwhile.
4. **Roll back.** `[Roll back]` asks `Roll back to abc1234? japa will restart.` with `[Roll back]` `[Cancel]`, then
   runs the same detached flow with `--to <previous sha>`; its report has no Roll back button.
5. **Already running.** While an update's state is `running` and its pid is alive, `/update` and the buttons answer
   `An update is already running (started Nm ago).`. A `running` state whose pid is dead is reported as
   `✗ update was interrupted; see ~/.japa/logs/update.log` and cleared.

Buttons use the menu's per-run token, so a confirm screen from before a restart expires (`send /update again`); the
report's `[Roll back]` button is the exception and carries the target sha (it must survive the restart it reports).

### 4.2 State file

`~/.japa/update.json`, written atomically (temp file + rename):

```ts
{ state: "running" | "updated" | "up to date" | "failed";
  pid?: number; started: number; finished?: number;
  chat: { adapter: string; chat: string };
  from: string; to?: string;            // full shas
  rollback: boolean;                    // this run was a Roll back
  restarted: "service" | "foreground" | "stopped" | "none";
  summary?: string; output?: string;    // failure line / its command output
  commits?: string[]; whatsNew?: string[];
  reported: boolean }
```

The full log of the run goes to `~/.japa/logs/update.log` (overwritten per run).

### 4.3 Check

`src/cli/update.ts` gains `checkForUpdate(app): Promise<{ current: string; target: string; commits: string[] }>`
(fetch + rev-list, no changes; the existing `--check` path uses it). The daemon calls it in-process through a new
`MessagingContext.update` object:

```ts
update: {
  check(): Promise<{ current: string; target: string; commits: string[] }>;
  start(chat: { adapter: string; chat: string }, to: string, rollback: boolean): Promise<void>;
  state(): Promise<UpdateState | undefined>;
  markReported(): Promise<void>;
}
```

### 4.4 Detached run

`start` refuses when an update is running (§4.1 step 5), writes `update.json` as `running` with no `pid` (the child
writes its own pid first thing; a `running` state still without a pid after 60 s counts as interrupted), then
launches `japa update --to <sha> --from-chat` so that restarting the daemon cannot kill it:

- **Linux with the systemd service active:** `systemd-run --user --collect --unit japa-update-<epoch>
  --setenv=PATH=<daemon's PATH> [--setenv=JAPA_HOME=<home>] <node> <main.ts> update …` (a transient unit outside `japa.service`'s cgroup; the service's `KillMode` would
  otherwise kill it with the daemon).
- **Otherwise** (macOS launchd, a foreground `japa daemon`, Linux without the service): `spawn` with
  `detached: true` (its own session and process group), stdio to `update.log`, `unref()`.

`--from-chat` (hidden flag) makes `japa update` non-interactive and write `update.json` at the end (and at each
failure path), from `UpdateOptions`/`UpdateDeps` (a new `report` dep, no-op in the CLI). The update logic, rollback
and restart rules (`restartAfterUpdate`) are unchanged. The restart now records which branch it took
(`restarted`).

### 4.5 Reporting

The messaging surface, for its own adapter, reports an unreported finished result when it starts and whenever
`update.json` changes (`fs.watch`, plus a 5 s poll while state is `running`): it sends the report to the recorded
chat (only if `chat.adapter` is its own name), then `markReported()`. So the old daemon reports a failure or a
no-restart result; the new daemon reports a success after the restart. A result for an adapter that isn't running
stays unreported until it is.

### 4.6 What's new

`japa setup --whats-new --non-interactive` already lists new extensions and new secrets/settings. In `--from-chat`
mode its output lines are captured into `whatsNew`, and the report adds `Configure them in /settings.` when there are
any.

### 4.7 Testing

- `test/messaging-menu.test.ts` with a fake `update`: up to date; commits listed (and `+M more`); Cancel; Update now
  calls `start` with the checked sha; already running; interrupted (dead pid); Roll back confirm → `start(…, true)`;
  expired confirm screen after restart; Roll back button survives a restart.
- `test/messaging.test.ts`: an unreported result is sent on start to the right chat and marked reported; a result for
  another adapter is left alone; a change to `update.json` while running is reported once.
- `test/update.test.ts`: `--from-chat` writes `update.json` for success (with `restarted`), up to date, each failure
  step with rollback, and `--to` used as a rollback.
- Unit test of the detached launch: the `systemd-run` argv when the service is active, `spawn` options otherwise
  (exec/spawn injected; no real process).

## 5. Docs

README: the Telegram section describes reply-to-prompt secrets and Decline, the `/update` command and Roll back;
the Google section's "as your next message in Telegram" becomes "as a reply to its prompt in Telegram"; the
Updating section mentions `/update`. The messaging spec's §5.4/§5.6 secret-request text and the install spec's §5
note this document.
