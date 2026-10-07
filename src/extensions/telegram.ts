import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Channel, Incoming } from "../core/contracts.ts";
import type { Extension } from "../core/host.ts";
import type { SettingsPrompt } from "../core/settings.ts";

export type TelegramConfig = { token: string; chatId: string };

// Never propagate fetch errors, response descriptions, JSON snippets or abort reasons:
// any of them can contain a bot token, a callback URL or a settings answer.
class TelegramError extends Error {}
class Cancelled extends TelegramError {
  constructor() {
    super("Telegram operation cancelled");
  }
}
const safe = (error: unknown) =>
  error instanceof TelegramError
    ? error
    : new TelegramError("Telegram operation failed");
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validate(config: TelegramConfig): TelegramConfig {
  if (
    typeof config.token !== "string" ||
    !/^[1-9]\d*:[A-Za-z0-9_-]{35}$/.test(config.token)
  )
    throw new TelegramError("Invalid Telegram bot token format");
  if (
    typeof config.chatId !== "string" ||
    !/^[1-9]\d*$/.test(config.chatId) ||
    !Number.isSafeInteger(Number(config.chatId))
  )
    throw new TelegramError(
      "Telegram chat ID must be a positive integer private owner ID",
    );
  return config;
}

async function privateJson(filename: string): Promise<unknown> {
  try {
    const file = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new TelegramError(
          "Telegram files must be private, owner-only regular files (chmod 600)",
        );
      return JSON.parse(await file.readFile("utf8")) as unknown;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof TelegramError) throw error;
    throw new TelegramError(
      "Unable to read private Telegram configuration or polling state",
    );
  }
}

/** Configuration is explicit; the first sender is never automatically trusted. */
export async function readTelegramConfig(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelegramConfig> {
  const data = await privateJson(join(home, "telegram.json"));
  if (data !== undefined && !object(data))
    throw new TelegramError("Invalid Telegram configuration");
  return validate({
    token: env.TELEGRAM_BOT_TOKEN ?? (data?.token as string),
    chatId: env.TELEGRAM_CHAT_ID ?? (data?.chatId as string),
  });
}

async function save(filename: string, value: unknown, home: string) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);
    const directory = await open(home, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    throw new TelegramError("Unable to save Telegram polling state");
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Conservative UTF-16 limit; preserve graphemes when they fit, always preserve code points. */
function chunks(text: string, limit = 4096): string[] {
  const result: string[] = [];
  let part = "";
  const append = (character: string) => {
    if (part.length + character.length > limit) {
      result.push(part);
      part = "";
    }
    part += character;
  };
  for (const { segment } of graphemes.segment(text)) {
    if (segment.length <= limit) append(segment);
    else for (const character of segment) append(character);
  }
  if (part) result.push(part);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Also works with an injected fetch that does not itself implement abort.
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new Cancelled());
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

const marker = "[Japa settings:";
type Prompt = {
  request: SettingsPrompt;
  tag: string;
  ids: Set<number>;
  boundary: number;
  ready: ReturnType<typeof deferred<void>>;
  answer: ReturnType<typeof deferred<string | undefined>>;
  done: boolean;
};

/** One owner, one polling loop. The caller holds the application's home lock. */
export function telegramChannel(options: {
  home: string;
  token: string;
  chatId: string;
  fetch?: typeof fetch;
  report?: (error: unknown) => void;
}): {
  channel: Channel;
  extension: Extension;
  closed: Promise<"exit" | "settings">;
  close(): Promise<void>;
} {
  const { token, chatId } = validate(options);
  const fetcher = options.fetch ?? globalThis.fetch;
  const shutdown = new AbortController();
  let stopping = false;
  let failure: TelegramError | undefined;
  let receiver: ((message: Incoming) => Promise<void>) | undefined;
  let prompt: Prompt | undefined;
  let routing = deferred<void>();
  const routingChanged = () => {
    routing.resolve();
    routing = deferred<void>();
  };
  let botId = "";
  let filename = "";
  let offset = 0;
  let ready: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const requests = new Set<Promise<unknown>>();
  let resolveClosed!: (reason: "exit" | "settings") => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<"exit" | "settings">((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Setup can fail before the CLI/Host has attached its closed handler.
  void closed.catch(() => {});

  function finish(active: Prompt, value?: string) {
    if (active.done) return;
    active.done = true;
    if (prompt === active) prompt = undefined;
    active.answer.resolve(value);
  }
  function fatal(error: unknown) {
    if (failure) return;
    failure = safe(error);
    stopping = true;
    shutdown.abort();
    if (prompt) finish(prompt);
    rejectClosed(failure);
    try {
      options.report?.(failure);
    } catch {
      /* Reports cannot break shutdown. */
    }
  }
  async function pause(ms: number, signal = shutdown.signal) {
    try {
      await delay(ms, undefined, { signal });
    } catch {
      throw new Cancelled();
    }
  }

  function api(
    method: string,
    body: object = {},
    signal?: AbortSignal,
    attempts = 5,
  ): Promise<unknown> {
    const work = (async () => {
      const cancellation = signal
        ? AbortSignal.any([shutdown.signal, signal])
        : shutdown.signal;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (cancellation.aborted) throw new Cancelled();
        let wait = Math.min(250 * 2 ** attempt, 5000);
        let retry = false;
        try {
          const deadline = AbortSignal.any([
            cancellation,
            AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000),
          ]);
          const response = await cancellable(
            fetcher(`https://api.telegram.org/bot${token}/${method}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: deadline,
            }),
            deadline,
          );
          // A non-JSON error body is untrusted too; never include it in an error.
          const data: unknown = await cancellable(
            response.json().catch(() => undefined),
            deadline,
          );
          const code =
            object(data) && integer(data.error_code)
              ? data.error_code
              : response.status;
          if (code === 401 || code === 403) {
            const error = new TelegramError(
              "Telegram authentication or owner access failed",
            );
            fatal(error);
            throw error;
          }
          if (code === 409) {
            const error = new TelegramError(
              "Telegram polling conflict (409): stop the other poller or webhook",
            );
            fatal(error);
            throw error;
          }
          if (response.ok && object(data) && data.ok === true)
            return data.result;
          retry = code === 408 || code === 425 || code === 429 || code >= 500;
          if (code === 429 && object(data) && object(data.parameters)) {
            const seconds = data.parameters.retry_after;
            if (typeof seconds === "number" && Number.isFinite(seconds))
              wait = Math.max(
                wait,
                Math.min(Math.max(seconds, 0) * 1000, 60_000),
              );
          }
          if (!retry) throw new TelegramError("Telegram API request failed");
        } catch (error) {
          if (cancellation.aborted) throw failure ?? new Cancelled();
          if (error instanceof TelegramError && !(error instanceof Cancelled))
            throw error;
          retry = true; // Network errors and request timeouts are retryable, but redacted.
        }
        if (!retry || attempt === attempts - 1)
          throw new TelegramError(
            "Telegram request failed after bounded retries",
          );
        await pause(wait, cancellation);
      }
      throw new TelegramError("Telegram API request failed");
    })();
    requests.add(work);
    void work.then(
      () => requests.delete(work),
      () => requests.delete(work),
    );
    return work;
  }

  async function sendText(text: string, signal?: AbortSignal) {
    for (const part of chunks(text))
      await api("sendMessage", { chat_id: chatId, text: part }, signal);
  }
  async function deleteReply(id: number) {
    // Deletion is best effort, not a promise of hidden or encrypted input.
    await api(
      "deleteMessage",
      { chat_id: chatId, message_id: id },
      undefined,
      1,
    ).catch(() => {});
  }
  async function display(active: Prompt, text: string, signal?: AbortSignal) {
    for (const part of chunks(text, 4096 - active.tag.length - 1)) {
      const result = await api(
        "sendMessage",
        {
          chat_id: chatId,
          text: `${active.tag}\n${part}`,
          reply_markup: { force_reply: true, selective: true },
        },
        signal,
      );
      if (
        !object(result) ||
        !integer(result.message_id) ||
        result.message_id === 0
      )
        throw new TelegramError("Telegram returned an invalid prompt receipt");
      active.ids.add(result.message_id);
      active.boundary = Math.min(active.boundary, result.message_id);
    }
  }
  const help =
    "Japa accepts text tasks and replies here. /settings opens the shared provider, login and model setup. Reply /approve ID or /deny ID to an approval request. Attachments and voice are not supported. Settings text is received by Telegram; secret replies are deleted best-effort, not hidden or end-to-end encrypted.";

  async function handle(
    update: Record<string, unknown>,
  ): Promise<(() => void) | "settings" | undefined> {
    const message = update.message;
    if (
      !object(message) ||
      !object(message.chat) ||
      !object(message.from) ||
      message.chat.type !== "private" ||
      String(message.chat.id) !== chatId ||
      String(message.from.id) !== chatId ||
      message.from.is_bot !== false ||
      !integer(message.message_id) ||
      message.message_id === 0
    )
      return;
    const reply = object(message.reply_to_message)
      ? message.reply_to_message
      : undefined;
    const fromBot =
      reply &&
      object(reply.from) &&
      String(reply.from.id) === botId &&
      reply.from.is_bot === true;
    // The marker lives in the Telegram prompt itself, surviving process restarts
    // and even a crash between sending the prompt and saving the next offset.
    const settingsReply =
      fromBot &&
      typeof reply.text === "string" &&
      reply.text.startsWith(marker);
    const active = prompt;
    if (active) {
      // A fast reply can beat sendMessage's receipt through an already-running
      // long poll. Keep it in settings routing and do not checkpoint it yet.
      await active.ready.promise;
      const currentReply =
        fromBot &&
        ((integer(reply.message_id) && active.ids.has(reply.message_id)) ||
          (typeof reply.text === "string" &&
            reply.text.startsWith(active.tag)));
      if (
        (settingsReply && !currentReply) ||
        (active.done && (settingsReply || currentReply))
      ) {
        await deleteReply(message.message_id);
        return;
      }
      if (
        active.done ||
        !(currentReply || (!reply && message.message_id > active.boundary))
      )
        return;
      if (active.request.kind === "text" && active.request.secret)
        await deleteReply(message.message_id);
      if (typeof message.text !== "string") return;
      const answer = message.text;
      const command = answer.trim();
      if (command === "/cancel") return () => finish(active);
      const selected =
        command === "/default" ? active.request.defaultValue : answer;
      if (active.request.kind === "text" && selected !== undefined)
        return () => finish(active, selected);
      if (active.request.kind === "choice" && selected !== undefined) {
        const choice =
          active.request.choices.find(
            (item) => item.value === selected.trim(),
          ) ??
          (/^[1-9]\d*$/.test(selected.trim())
            ? active.request.choices[Number(selected.trim()) - 1]
            : undefined);
        if (choice) return () => finish(active, choice.value);
      }
      await display(
        active,
        "Choose a listed number or value, /default (when available), or /cancel.",
      );
      return;
    }
    if (settingsReply) {
      await deleteReply(message.message_id);
      return;
    }
    if (typeof message.text !== "string") return;
    const command = message.text.trim();
    if (
      /^\/(start|help)(?:@\w+)?(?:\s|$)/.test(command) ||
      command === "/exit"
    ) {
      await sendText(help);
      return;
    }
    if (!receiver) {
      // Do not silently ACK a task in the gap between settings and Host.start.
      // A new prompt can claim setup input; otherwise wait for durable ingress.
      await cancellable(routing.promise, shutdown.signal);
      return handle(update);
    }
    if (command === "/settings") return "settings";
    try {
      await receiver({
        id: `telegram:${botId}:${update.update_id}`,
        address: { channel: "telegram", recipient: chatId },
        text: message.text,
      });
    } catch {
      throw new TelegramError(
        "Telegram admission failed; update not acknowledged",
      );
    }
  }

  const polling = (timeout: number) => ({
    ...(offset ? { offset } : {}),
    timeout,
    allowed_updates: ["message"],
  });
  async function poll() {
    while (!stopping) {
      const result = await api("getUpdates", polling(25));
      if (
        !Array.isArray(result) ||
        result.some(
          (item: unknown) =>
            !object(item) ||
            !integer(item.update_id) ||
            item.update_id === Number.MAX_SAFE_INTEGER,
        )
      )
        throw new TelegramError("Telegram returned invalid updates");
      const updates = (result as Record<string, unknown>[]).sort(
        (a, b) => Number(a.update_id) - Number(b.update_id),
      );
      let progressed = false;
      for (const update of updates) {
        if (stopping) break;
        const id = Number(update.update_id);
        if (id < offset) continue;
        const action = await handle(update);
        // Complete admission and its checkpoint even if close() arrived meanwhile.
        await save(
          filename,
          { version: 1, botId, nextOffset: id + 1 },
          options.home,
        );
        offset = id + 1;
        progressed = true;
        if (action === "settings" && !stopping) {
          // getUpdates(offset > update_id), not a local write alone, ACKs Telegram.
          // Returned later updates are deliberately left unacknowledged for reopening.
          await api("getUpdates", { ...polling(1), limit: 1 });
          stopping = true;
          shutdown.abort();
          resolveClosed("settings");
          return;
        }
        if (typeof action === "function") action();
      }
      // Real long polls wait remotely; instant empty test/proxy responses must not spin.
      if (!progressed && !stopping) await pause(100);
    }
  }

  async function initialize() {
    const me = await api("getMe");
    if (!object(me) || !integer(me.id) || me.id === 0 || me.is_bot !== true)
      throw new TelegramError("Telegram returned an invalid bot identity");
    botId = String(me.id);
    const webhook = await api("getWebhookInfo");
    if (!object(webhook) || typeof webhook.url !== "string")
      throw new TelegramError("Telegram returned invalid webhook information");
    if (webhook.url)
      throw new TelegramError(
        "Telegram has an existing webhook; disable it explicitly before using polling",
      );
    // Per-bot checkpoints survive token rotation and cannot skip another bot's updates.
    filename = join(options.home, `telegram-offset-${botId}.json`);
    const state = await privateJson(filename);
    if (state !== undefined) {
      if (
        !object(state) ||
        state.version !== 1 ||
        state.botId !== botId ||
        !integer(state.nextOffset)
      )
        throw new TelegramError("Invalid Telegram polling state");
      offset = state.nextOffset;
    }
    if (!stopping)
      loop = poll().catch((error: unknown) => {
        if (!(error instanceof Cancelled && stopping)) fatal(error);
      });
  }
  function ensure(signal?: AbortSignal): Promise<void> {
    if (failure) return Promise.reject(failure);
    if (stopping) return Promise.reject(new Cancelled());
    ready ??= initialize().catch((error: unknown) => {
      if (!(error instanceof Cancelled && stopping)) fatal(error);
      throw safe(error);
    });
    return signal ? cancellable(ready, signal) : ready;
  }

  function close(): Promise<void> {
    return (closing ??= (async () => {
      stopping = true;
      shutdown.abort();
      if (prompt) finish(prompt);
      await ready?.catch(() => {});
      await loop;
      await Promise.allSettled([...requests]);
      resolveClosed("exit");
    })());
  }

  const channel: Channel = {
    settings: {
      async notify(message, context) {
        if (context.abortSignal?.aborted) throw new Cancelled();
        await ensure(context.abortSignal);
        await sendText(message, context.abortSignal);
      },
      async prompt(request, context) {
        if (context.abortSignal?.aborted || stopping) {
          if (failure) throw failure;
          return undefined;
        }
        if (prompt)
          throw new TelegramError(
            "A Telegram settings prompt is already active",
          );
        const active: Prompt = {
          request,
          tag: `${marker}${randomUUID()}]`,
          ids: new Set(),
          boundary: Infinity,
          ready: deferred<void>(),
          answer: deferred<string | undefined>(),
          done: false,
        };
        // Reserve settings routing BEFORE initialization or prompt publication.
        prompt = active;
        routingChanged();
        const abort = () => finish(active);
        context.abortSignal?.addEventListener("abort", abort, { once: true });
        try {
          await ensure(context.abortSignal);
          if (active.done) return undefined;
          const lines = [request.title];
          if (request.kind === "choice")
            request.choices.forEach((choice, index) =>
              lines.push(
                `${index + 1}. ${choice.label}${choice.value === request.defaultValue ? " (default)" : ""}`,
              ),
            );
          if (request.kind === "text" && request.secret)
            lines.push(
              "Warning: Telegram receives this text. Your reply will be deleted best-effort; this is not hidden or end-to-end encrypted input.",
            );
          if (request.defaultValue !== undefined)
            lines.push(
              request.kind === "text" && !request.secret
                ? `Default: ${request.defaultValue}`
                : "A default is available.",
            );
          lines.push(
            "Reply to this prompt. /default uses the default; /cancel cancels.",
          );
          await display(active, lines.join("\n"), context.abortSignal);
          active.ready.resolve();
          const answer = await active.answer.promise;
          if (failure) throw failure;
          return answer;
        } catch (error) {
          if (failure) throw failure;
          if (context.abortSignal?.aborted || stopping) return undefined;
          throw safe(error);
        } finally {
          active.ready.resolve();
          finish(active);
          context.abortSignal?.removeEventListener("abort", abort);
        }
      },
    },
    async start(receive) {
      if (receiver) throw new TelegramError("Telegram channel already started");
      receiver = receive;
      routingChanged();
      await ensure();
      return close;
    },
    async send(address, message, _key, context) {
      if (address.channel !== "telegram" || address.recipient !== chatId)
        throw new TelegramError("Unknown Telegram destination");
      if (context.abortSignal?.aborted) throw new Cancelled();
      await ensure(context.abortSignal);
      // Telegram has no idempotency key: ambiguous failures and host retries can
      // duplicate delivery, including already-sent chunks (explicitly at-least-once).
      await sendText(message.text, context.abortSignal);
    },
  };
  const extension: Extension = {
    name: "japa.telegram",
    adapters: { channel: () => channel },
  };
  return { channel, extension, closed, close };
}
