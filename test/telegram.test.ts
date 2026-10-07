import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Incoming } from "../src/core/contracts.ts";
import {
  telegramChannel,
  readTelegramConfig,
} from "../src/extensions/telegram.ts";
import { context, until } from "./helpers.ts";

const token = `100001:${"T".repeat(35)}`; // Deliberately fake; fetch is always injected.
const owner = "42";
const address = { channel: "telegram", recipient: owner };
type Update = { update_id: number; message?: Record<string, unknown> };
type Call = {
  method: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
};
const ok = (result: unknown) => Response.json({ ok: true, result });
const error = (code: number, description = "untrusted", retryAfter = 0) =>
  Response.json(
    {
      ok: false,
      error_code: code,
      description,
      parameters: { retry_after: retryAfter },
    },
    { status: code },
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class Telegram {
  botId = 100001;
  calls: Call[] = [];
  sent: { id: number; text: string; body: Record<string, unknown> }[] = [];
  queued: Update[] = [];
  deleted: number[] = [];
  sequence = 1000;
  polls = 0;
  maxPolls = 0;
  empty = false;
  wake?: () => void;
  intercept?: (call: Call) => Response | Promise<Response> | undefined;

  message(
    id: number,
    text: string,
    extra: Record<string, unknown> = {},
  ): Update {
    return {
      update_id: id,
      message: {
        message_id: ++this.sequence,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(owner), type: "private" },
        from: { id: Number(owner), is_bot: false },
        text,
        ...extra,
      },
    };
  }
  reply(id: number, text: string, sent = this.sent.at(-1)!): Update {
    return this.message(id, text, {
      reply_to_message: {
        message_id: sent.id,
        text: sent.text,
        from: { id: this.botId, is_bot: true },
      },
    });
  }
  push(...updates: Update[]) {
    this.queued.push(...updates);
    this.wake?.();
  }
  count(method: string) {
    return this.calls.filter((call) => call.method === method).length;
  }
  fetch: typeof fetch = async (url, init) => {
    const method = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const signal = init?.signal as AbortSignal;
    const call = { method, body, signal };
    this.calls.push(call);
    const polling = method === "getUpdates";
    if (polling) {
      this.polls++;
      this.maxPolls = Math.max(this.maxPolls, this.polls);
    }
    try {
      const intercepted = this.intercept?.(call);
      if (intercepted) return await intercepted;
      if (method === "getMe") return ok({ id: this.botId, is_bot: true });
      if (method === "getWebhookInfo") return ok({ url: "" });
      if (method === "sendMessage") {
        const id = ++this.sequence;
        this.sent.push({ id, text: String(body.text), body });
        return ok({ message_id: id });
      }
      if (method === "deleteMessage") {
        this.deleted.push(Number(body.message_id));
        return ok(true);
      }
      assert.equal(
        method,
        "getUpdates",
        "must not change webhooks or bot commands",
      );
      assert(Number(body.timeout) > 0);
      assert.deepEqual(body.allowed_updates, ["message"]);
      assert(!("drop_pending_updates" in body));
      if (body.offset !== undefined) {
        assert(Number(body.offset) > 0);
        this.queued = this.queued.filter(
          (update) => update.update_id >= Number(body.offset),
        );
      }
      if (!this.queued.length && !this.empty && body.limit !== 1) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            this.wake = undefined;
            signal.removeEventListener("abort", abort);
          };
          const abort = () => {
            cleanup();
            reject(new Error(`fetch aborted: ${token}`));
          };
          this.wake = () => {
            cleanup();
            resolve();
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      return ok(this.queued.slice(0, Number(body.limit ?? 100)));
    } finally {
      if (polling) this.polls--;
    }
  };
}

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "japa-telegram-"));
  const telegram = new Telegram();
  const reports: unknown[] = [];
  const instances: ReturnType<typeof telegramChannel>[] = [];
  const create = (botToken = token) => {
    const instance = telegramChannel({
      home,
      token: botToken,
      chatId: owner,
      fetch: telegram.fetch,
      report: (err) => reports.push(err),
    });
    instances.push(instance);
    return instance;
  };
  t.after(async () => {
    await Promise.all(instances.map((instance) => instance.close()));
    await rm(home, { recursive: true, force: true });
  });
  const checkpoint = async (botId = telegram.botId) => {
    try {
      return JSON.parse(
        await readFile(join(home, `telegram-offset-${botId}.json`), "utf8"),
      ) as { nextOffset: number };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };
  return { home, telegram, reports, create, checkpoint };
}

test("Telegram config requires an explicit private owner and never echoes invalid tokens", async (t) => {
  const { home } = await fixture(t);
  assert.deepEqual(
    await readTelegramConfig(home, {
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_CHAT_ID: owner,
    }),
    { token, chatId: owner },
  );
  await assert.rejects(readTelegramConfig(home, {}), /token format/);
  for (const chatId of [
    "",
    "0",
    "-42",
    "1.5",
    "+42",
    "042",
    "9007199254740992",
    "@owner",
  ]) {
    assert.throws(
      () =>
        telegramChannel({ home, token, chatId, fetch: new Telegram().fetch }),
      /positive integer/,
    );
  }
  const secret = "bad-token-DO-NOT-PRINT";
  await assert.rejects(
    readTelegramConfig(home, {
      TELEGRAM_BOT_TOKEN: secret,
      TELEGRAM_CHAT_ID: owner,
    }),
    (err: Error) => {
      assert(!err.message.includes(secret));
      return /token format/.test(err.message);
    },
  );
});

test("private telegram.json supports environment overrides and rejects unsafe or malformed files", async (t) => {
  const { home } = await fixture(t);
  const filename = join(home, "telegram.json");
  await writeFile(filename, JSON.stringify({ token, chatId: owner }), {
    mode: 0o600,
  });
  assert.deepEqual(await readTelegramConfig(home, {}), {
    token,
    chatId: owner,
  });
  const override = `100002:${"U".repeat(35)}`;
  assert.deepEqual(
    await readTelegramConfig(home, {
      TELEGRAM_BOT_TOKEN: override,
      TELEGRAM_CHAT_ID: "99",
    }),
    { token: override, chatId: "99" },
  );
  await chmod(filename, 0o644);
  await assert.rejects(readTelegramConfig(home, {}), /private/);
  await chmod(filename, 0o600);
  await writeFile(filename, `{"token":"${token}`);
  await assert.rejects(
    readTelegramConfig(home, {}),
    (err: Error) => !err.message.includes(token),
  );
  await rm(filename);
  const target = join(home, "linked.json");
  await writeFile(target, JSON.stringify({ token, chatId: owner }), {
    mode: 0o600,
  });
  await symlink(target, filename);
  await assert.rejects(readTelegramConfig(home, {}), /private/);
});

test("allowlist rejects bots, other senders, groups and non-message updates; approvals stay unchanged", async (t) => {
  const { create, telegram, checkpoint } = await fixture(t);
  const instance = create();
  assert.equal(instance.extension.name, "japa.telegram");
  const received: Incoming[] = [];
  await instance.channel.start(async (message) => {
    received.push(message);
  });
  telegram.push(
    telegram.message(1, "wrong sender", { from: { id: 99, is_bot: false } }),
    telegram.message(2, "wrong chat", { chat: { id: 99, type: "private" } }),
    telegram.message(3, "bot", { from: { id: 42, is_bot: true } }),
    telegram.message(4, "group", { chat: { id: 42, type: "group" } }),
    telegram.message(5, "supergroup", {
      chat: { id: -42, type: "supergroup" },
    }),
    telegram.message(6, "anonymous", { from: undefined }),
    telegram.message(7, "photo", { text: undefined, photo: [{}] }),
    { update_id: 8 },
    telegram.message(9, "/approve request-1"),
    telegram.message(10, "/deny request-2"),
  );
  await until(async () => (await checkpoint())?.nextOffset === 11);
  assert.deepEqual(received, [
    { id: "telegram:100001:9", address, text: "/approve request-1" },
    { id: "telegram:100001:10", address, text: "/deny request-2" },
  ]);
  assert.equal(telegram.sent.length, 0);
  assert.equal(telegram.maxPolls, 1);
  assert.deepEqual(
    telegram.calls.slice(0, 3).map((call) => call.method),
    ["getMe", "getWebhookInfo", "getUpdates"],
  );
  await assert.rejects(
    instance.channel.send(
      { channel: "telegram", recipient: "99" },
      { text: "no" },
      "key",
      context,
    ),
    /destination/,
  );
  await assert.rejects(
    instance.channel.send(
      { channel: "other", recipient: owner },
      { text: "no" },
      "key",
      context,
    ),
    /destination/,
  );
});

test("failed admission is not checkpointed or acknowledged, and reopen replays the same stable ID", async (t) => {
  const { create, telegram, checkpoint, reports, home } = await fixture(t);
  const first = create();
  const ids: string[] = [];
  telegram.push(telegram.message(80, "task"));
  await first.channel.start(async (message) => {
    ids.push(message.id);
    throw new Error(`private reply ${token} https://secret.invalid/`);
  });
  await assert.rejects(first.closed, /admission failed/);
  await first.close();
  assert.equal(await checkpoint(), undefined);
  assert.equal(
    telegram.calls.filter((call) => call.method === "getUpdates").length,
    1,
  );
  assert.equal(reports.length, 1);
  assert(!String(reports[0]).includes(token));
  const second = create();
  await second.channel.start(async (message) => {
    ids.push(message.id);
  });
  await until(async () => (await checkpoint())?.nextOffset === 81);
  await until(() =>
    telegram.calls.some(
      (call) => call.method === "getUpdates" && call.body.offset === 81,
    ),
  );
  assert.deepEqual(ids, ["telegram:100001:80", "telegram:100001:80"]);
  assert.equal(
    (await stat(join(home, "telegram-offset-100001.json"))).mode & 0o777,
    0o600,
  );
  assert(!(await readdir(home)).some((name) => name.endsWith(".tmp")));
});

test("offsets are per bot identity, preserved across token rotation, not reused for another bot", async (t) => {
  const { create, telegram, checkpoint } = await fixture(t);
  telegram.push(telegram.message(100, "one"));
  const first = create();
  await first.channel.start(async () => {});
  await until(async () => (await checkpoint())?.nextOffset === 101);
  await first.close();
  let calls = telegram.calls.length;
  const rotated = create(`100001:${"R".repeat(35)}`);
  await rotated.channel.start(async () => {});
  await until(() =>
    telegram.calls.slice(calls).some((call) => call.method === "getUpdates"),
  );
  assert.equal(
    telegram.calls.slice(calls).find((call) => call.method === "getUpdates")
      ?.body.offset,
    101,
  );
  await rotated.close();
  telegram.botId = 100002;
  telegram.queued = [];
  telegram.push(telegram.message(2, "other bot"));
  calls = telegram.calls.length;
  const other = create(`100002:${"N".repeat(35)}`);
  await other.channel.start(async () => {});
  await until(async () => (await checkpoint())?.nextOffset === 3);
  assert.equal(
    telegram.calls.slice(calls).find((call) => call.method === "getUpdates")
      ?.body.offset,
    undefined,
  );
  assert.equal((await checkpoint(100001))?.nextOffset, 101);
});

test("webhook refusal is visible before Host exists and never deletes or logs the webhook", async (t) => {
  const { create, telegram, reports } = await fixture(t);
  telegram.intercept = ({ method }) =>
    method === "getWebhookInfo"
      ? ok({ url: `https://private.invalid/${token}` })
      : undefined;
  const instance = create();
  await assert.rejects(
    instance.channel.settings.notify("setup", context),
    /existing webhook/,
  );
  // closed already has an internal rejection handler while the parent is still in setup.
  await delay(5);
  await assert.rejects(instance.closed, /existing webhook/);
  assert.equal(telegram.count("getUpdates"), 0);
  assert.equal(telegram.count("deleteWebhook"), 0);
  assert(!String(reports[0]).includes("https://"));
  assert(!String(reports[0]).includes(token));
  await instance.close();
});

for (const code of [401, 403, 409]) {
  test(`Telegram ${code} fails visibly with redacted errors and no retries`, async (t) => {
    const { create, telegram, reports } = await fixture(t);
    const secret = `reply-secret https://api.telegram.org/bot${token}/getUpdates`;
    telegram.intercept = ({ method }) =>
      method === "getUpdates" ? error(code, secret) : undefined;
    const instance = create();
    await instance.channel.start(async () => {});
    await assert.rejects(instance.closed, (err: Error) => {
      assert(!err.message.includes(secret));
      assert(!err.message.includes(token));
      assert(!err.message.includes("https://"));
      return code === 409
        ? /conflict/.test(err.message)
        : /authentication/.test(err.message);
    });
    assert.equal(telegram.count("getUpdates"), 1);
    assert.equal(reports.length, 1);
  });
}

test("transient network/429/500 failures retry, without exposing descriptions or creating parallel polls", async (t) => {
  const { create, telegram, reports } = await fixture(t);
  let attempt = 0;
  telegram.intercept = ({ method }) => {
    if (method !== "getUpdates") return;
    attempt++;
    if (attempt === 1)
      throw new Error(`https://api.telegram.org/bot${token}/getUpdates`);
    if (attempt === 2) return error(429, token, 0);
    if (attempt === 3) return error(500, token);
  };
  telegram.push(telegram.message(1, "after retries"));
  const instance = create();
  const received: Incoming[] = [];
  await instance.channel.start(async (message) => {
    received.push(message);
  });
  await until(() => received.length === 1);
  assert.equal(received[0]?.text, "after retries");
  assert.equal(reports.length, 0);
  assert.equal(telegram.maxPolls, 1);
});

test("exhausted network retries are bounded and errors contain neither URLs nor tokens", async (t) => {
  const { create, telegram, reports } = await fixture(t);
  telegram.intercept = () => {
    throw new Error(`https://api.telegram.org/bot${token}/getMe reply-secret`);
  };
  const instance = create();
  await assert.rejects(
    instance.channel.settings.notify("setup", context),
    /bounded retries/,
  );
  await assert.rejects(instance.closed, /bounded retries/);
  assert.equal(telegram.count("getMe"), 5);
  assert(!String(reports[0]).includes(token));
  assert(!String(reports[0]).includes("https://"));
  assert(!String(reports[0]).includes("reply-secret"));
});

test("closing interrupts a long 429 backoff", async (t) => {
  const { create, telegram } = await fixture(t);
  telegram.intercept = ({ method }) =>
    method === "getUpdates" ? error(429, token, 3600) : undefined;
  const instance = create();
  await instance.channel.start(async () => {});
  await until(() => telegram.count("getUpdates") === 1);
  await instance.close();
  assert.equal(await instance.closed, "exit");
  assert.equal(telegram.count("getUpdates"), 1);
});

test("sendMessage splits Unicode safely, validates destinations and is explicitly at-least-once", async (t) => {
  const { create, telegram } = await fixture(t);
  const instance = create();
  const cluster = "👩🏽‍💻";
  const text = "a".repeat(4094) + cluster + "😀日本語".repeat(1800) + "𐐷";
  await instance.channel.send(address, { text }, "same-key", context);
  const sent = telegram.sent.map((message) => message.text);
  assert.equal(sent.join(""), text);
  assert.equal(sent[0], "a".repeat(4094));
  assert(sent[1]!.startsWith(cluster));
  assert(sent.length > 2);
  for (const part of sent) {
    assert(part.length <= 4096);
    assert.equal(Buffer.from(part).toString("utf8"), part);
  }
  assert(telegram.sent.every((message) => !("parse_mode" in message.body)));
  await instance.channel.send(address, { text: "retry" }, "same-key", context);
  await instance.channel.send(address, { text: "retry" }, "same-key", context);
  assert.deepEqual(
    telegram.sent.slice(-2).map((message) => message.text),
    ["retry", "retry"],
  );
});

test("shared SettingsUI starts before Host, reuses one poller and never admits setup answers", async (t) => {
  const { create, telegram, checkpoint } = await fixture(t);
  const instance = create();
  await instance.channel.settings.notify(
    "Open the provider OAuth URL",
    context,
  );
  const old = telegram.message(1, "queued before the prompt");
  const answer = instance.channel.settings.prompt(
    {
      kind: "choice",
      title: "Provider",
      choices: [
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
      ],
      defaultValue: "openai",
    },
    context,
  );
  await until(() => telegram.sent.length === 2);
  const sent = telegram.sent[1]!;
  assert.match(sent.text, /1\. OpenAI \(default\)/);
  assert.match(sent.text, /2\. Anthropic/);
  assert.deepEqual(sent.body.reply_markup, {
    force_reply: true,
    selective: true,
  });
  telegram.push(old, telegram.reply(2, "2", sent));
  assert.equal(await answer, "anthropic");
  assert.equal(
    (await checkpoint())?.nextOffset,
    3,
    "settings answer committed before prompt resolves",
  );
  telegram.push(telegram.message(3, "ordinary input before Host"));
  await until(() => telegram.polls === 0);
  assert.equal(
    (await checkpoint())?.nextOffset,
    3,
    "do not ACK input before ingress exists",
  );
  const received: Incoming[] = [];
  await instance.channel.start(async (message) => {
    received.push(message);
  });
  telegram.push(telegram.message(4, "ordinary input after Host"));
  await until(() => received.length === 2);
  assert.deepEqual(
    received.map((message) => message.text),
    ["ordinary input before Host", "ordinary input after Host"],
  );
  assert.equal(telegram.count("getMe"), 1);
  assert.equal(telegram.count("getWebhookInfo"), 1);
  assert.equal(telegram.maxPolls, 1);
});

for (const threaded of [false, true]) {
  test(`fast ${threaded ? "ForceReply" : "plain"} secret reply waits for the in-flight prompt receipt`, async (t) => {
    const { create, telegram, checkpoint } = await fixture(t);
    const instance = create();
    const received: Incoming[] = [];
    await instance.channel.start(async (message) => {
      received.push(message);
    });
    await until(() => telegram.polls === 1);
    const receipt = deferred<Response>();
    telegram.intercept = ({ method, body }) => {
      if (method !== "sendMessage") return;
      // Telegram has published the prompt but the sendMessage response is delayed.
      telegram.sent.push({
        id: ++telegram.sequence,
        text: String(body.text),
        body,
      });
      return receipt.promise;
    };
    const answer = instance.channel.settings.prompt(
      { kind: "text", title: "API key", secret: true },
      context,
    );
    await until(() => telegram.sent.length === 1);
    const update = threaded
      ? telegram.reply(30, "fast-secret")
      : telegram.message(30, "fast-secret");
    telegram.push(update);
    await until(() => telegram.polls === 0);
    await delay(10);
    assert.equal(
      await checkpoint(),
      undefined,
      "must not drop/ack the pending settings reply",
    );
    assert.equal(telegram.count("getUpdates"), 1);
    assert.equal(received.length, 0);
    receipt.resolve(ok({ message_id: telegram.sent[0]!.id }));
    assert.equal(await answer, "fast-secret");
    assert.equal((await checkpoint())?.nextOffset, 31);
    assert.deepEqual(telegram.deleted, [update.message!.message_id]);
    assert.equal(received.length, 0);
  });
}

test("long settings choices are numbered and split with a recognizable marker on every page", async (t) => {
  const { create, telegram } = await fixture(t);
  const instance = create();
  const choices = Array.from({ length: 180 }, (_, index) => ({
    value: `model-${index}`,
    label: `Model ${index} ${"😀".repeat(30)}`,
  }));
  const answer = instance.channel.settings.prompt(
    { kind: "choice", title: "Main model", choices },
    context,
  );
  await until(() =>
    telegram.sent.some((message) => message.text.includes("180. Model 179")),
  );
  const pages = [...telegram.sent];
  assert(pages.length > 2);
  for (const page of pages) {
    assert(page.text.startsWith("[Japa settings:"));
    assert(page.text.length <= 4096);
    assert.equal(Buffer.from(page.text).toString("utf8"), page.text);
  }
  telegram.push(telegram.reply(1, "180", pages[0]));
  assert.equal(await answer, "model-179");
});

test("settings validates choices, supports defaults/text OAuth callback/cancel, and checks the owner", async (t) => {
  const { create, telegram } = await fixture(t);
  const instance = create();
  const received: Incoming[] = [];
  await instance.channel.start(async (message) => {
    received.push(message);
  });
  let answer = instance.channel.settings.prompt(
    {
      kind: "choice",
      title: "Model",
      choices: [{ value: "one", label: "One" }],
      defaultValue: "one",
    },
    context,
  );
  await until(() => telegram.sent.length === 1);
  telegram.push(telegram.reply(1, "999"));
  await until(() => telegram.sent.length === 2);
  assert(!telegram.sent[1]?.text.includes("999"));
  telegram.push(
    telegram.message(2, "one", { from: { id: 99, is_bot: false } }),
    telegram.reply(3, "/default"),
  );
  assert.equal(await answer, "one");
  answer = instance.channel.settings.prompt(
    { kind: "text", title: "OAuth callback text" },
    context,
  );
  await until(() => telegram.sent.length === 3);
  const callback =
    "http://localhost:7777/callback?code=fake-auth-code&state=fake-state";
  telegram.push(telegram.message(4, callback));
  assert.equal(await answer, callback);
  answer = instance.channel.settings.prompt(
    { kind: "text", title: "Optional setting", defaultValue: "saved" },
    context,
  );
  await until(() => telegram.sent.length === 4);
  assert.match(telegram.sent[3]!.text, /Default: saved/);
  telegram.push(telegram.reply(5, "/default"));
  assert.equal(await answer, "saved");
  answer = instance.channel.settings.prompt(
    { kind: "text", title: "Cancel" },
    context,
  );
  await until(() => telegram.sent.length === 5);
  telegram.push(telegram.reply(6, "/cancel"));
  assert.equal(await answer, undefined);
  assert.deepEqual(received, []);
});

test("secret replies are warned about, deleted immediately, never echoed or admitted", async (t) => {
  const { create, telegram, reports } = await fixture(t);
  const instance = create();
  const received: Incoming[] = [];
  await instance.channel.start(async (message) => {
    received.push(message);
  });
  const secret = "sk-fake-private-settings-answer";
  const answer = instance.channel.settings.prompt(
    { kind: "text", title: "API key", secret: true, defaultValue: secret },
    context,
  );
  await until(() => telegram.sent.length === 1);
  const sent = telegram.sent[0]!;
  assert.match(sent.text, /Telegram receives this text/);
  assert.match(sent.text, /not hidden or end-to-end encrypted/);
  assert(!sent.text.includes(secret));
  const reply = telegram.reply(1, secret);
  telegram.push(reply);
  assert.equal(await answer, secret);
  assert.deepEqual(telegram.deleted, [reply.message!.message_id]);
  assert.deepEqual(received, []);
  assert.deepEqual(reports, []);
  assert(!telegram.sent.some((message) => message.text.includes(secret)));
});

test("secret deletion is best-effort even if Telegram refuses it", async (t) => {
  const { create, telegram } = await fixture(t);
  const instance = create();
  telegram.intercept = ({ method }) =>
    method === "deleteMessage" ? error(400, "private-reply") : undefined;
  const answer = instance.channel.settings.prompt(
    { kind: "text", title: "Key", secret: true },
    context,
  );
  await until(() => telegram.sent.length === 1);
  telegram.push(telegram.reply(1, "private-reply"));
  assert.equal(await answer, "private-reply");
  assert.equal(telegram.count("deleteMessage"), 1);
});

test("late replies to old settings prompts are suppressed/deleted after restart and during another prompt", async (t) => {
  const { create, telegram, checkpoint } = await fixture(t);
  const first = create();
  const answer = first.channel.settings.prompt(
    { kind: "text", title: "Key", secret: true },
    context,
  );
  await until(() => telegram.sent.length === 1);
  const oldPrompt = telegram.sent[0]!;
  telegram.push(telegram.reply(1, "/cancel", oldPrompt));
  assert.equal(await answer, undefined);
  await first.close();
  const second = create();
  const received: Incoming[] = [];
  await second.channel.start(async (message) => {
    received.push(message);
  });
  const late = telegram.reply(2, "late-secret", oldPrompt);
  telegram.push(late);
  await until(async () => (await checkpoint())?.nextOffset === 3);
  const next = second.channel.settings.prompt(
    { kind: "text", title: "New prompt" },
    context,
  );
  await until(() => telegram.sent.length === 2);
  const stale = telegram.reply(3, "another-late-secret", oldPrompt);
  telegram.push(stale, telegram.reply(4, "current answer"));
  assert.equal(await next, "current answer");
  telegram.push(telegram.message(5, "normal chat"));
  await until(() => received.length === 1);
  assert.equal(received[0]?.text, "normal chat");
  assert(telegram.deleted.includes(Number(late.message!.message_id)));
  assert(telegram.deleted.includes(Number(stale.message!.message_id)));
});

test("/settings persists and remotely ACKs before handoff, leaving later updates for the next channel", async (t) => {
  const { create, telegram, checkpoint } = await fixture(t);
  const first = create();
  const ack = deferred<Response>();
  let ackStarted = false;
  telegram.intercept = (call) => {
    if (call.method === "getUpdates" && call.body.limit === 1) {
      ackStarted = true;
      assert.equal(call.body.offset, 11);
      return ack.promise;
    }
  };
  const received: Incoming[] = [];
  await first.channel.start(async (message) => {
    received.push(message);
  });
  let closed = false;
  void first.closed.then(() => {
    closed = true;
  });
  telegram.push(
    telegram.message(10, "/settings"),
    telegram.message(11, "after settings"),
  );
  await until(() => ackStarted);
  assert.equal((await checkpoint())?.nextOffset, 11);
  assert.equal(closed, false);
  assert.equal(received.length, 0);
  ack.resolve(ok([telegram.queued[1]]));
  assert.equal(await first.closed, "settings");
  await first.close();
  telegram.intercept = undefined;
  const second = create();
  await second.channel.start(async (message) => {
    received.push(message);
  });
  await until(() => received.length === 1);
  assert.equal(received[0]?.text, "after settings");
  assert.equal(telegram.maxPolls, 1);
});

test("help explains capabilities/setup/approval; /exit does not remotely stop the service", async (t) => {
  const { create, telegram, checkpoint } = await fixture(t);
  const instance = create();
  const received: Incoming[] = [];
  await instance.channel.start(async (message) => {
    received.push(message);
  });
  assert.equal(telegram.sent.length, 0, "no unsolicited ready message");
  telegram.push(
    telegram.message(1, "/start"),
    telegram.message(2, "/help"),
    telegram.message(3, "/exit"),
  );
  await until(async () => (await checkpoint())?.nextOffset === 4);
  assert.equal(telegram.sent.length, 3);
  assert.match(telegram.sent[0]!.text, /\/settings/);
  assert.match(telegram.sent[0]!.text, /\/approve ID/);
  assert.match(telegram.sent[0]!.text, /Attachments and voice/);
  assert(!telegram.sent[0]!.text.includes("/exit"));
  telegram.push(telegram.message(4, "still running"));
  await until(() => received.length === 1);
});

test("shutdown waits for in-flight admission and checkpoints it, is idempotent and aborts polling", async (t) => {
  const { create, telegram, checkpoint } = await fixture(t);
  const instance = create();
  const admitted = deferred<void>();
  let entered = false;
  const dispose = await instance.channel.start(async () => {
    entered = true;
    await admitted.promise;
  });
  telegram.push(telegram.message(1, "pending admission"));
  await until(() => entered);
  let done = false;
  const closing = instance.close();
  assert.equal(instance.close(), closing);
  void closing.then(() => {
    done = true;
  });
  await delay(5);
  assert.equal(done, false);
  assert.equal(await checkpoint(), undefined);
  admitted.resolve();
  await closing;
  await dispose();
  assert.equal((await checkpoint())?.nextOffset, 2);
  assert.equal(await instance.closed, "exit");
  assert.equal(telegram.polls, 0);
});

test("prompt cancellation and close unblock setup without a Host or leaking abort reasons", async (t) => {
  const { create, telegram } = await fixture(t);
  const instance = create();
  const controller = new AbortController();
  const answer = instance.channel.settings.prompt(
    { kind: "text", title: "OAuth callback", secret: true },
    withAbortSignal(controller.signal, context),
  );
  await until(() => telegram.sent.length === 1);
  controller.abort(new Error(`private reason ${token}`));
  assert.equal(await answer, undefined);
  const another = instance.channel.settings.prompt(
    { kind: "choice", title: "Provider", choices: [] },
    context,
  );
  await until(() => telegram.sent.length === 2);
  await instance.close();
  assert.equal(await another, undefined);
  assert.equal(await instance.closed, "exit");
  assert.equal(telegram.polls, 0);
});

test("setup context cancellation also interrupts initialization, and close works before start", async (t) => {
  const { create, telegram } = await fixture(t);
  const stuck = deferred<Response>();
  telegram.intercept = ({ method }) =>
    method === "getMe" ? stuck.promise : undefined;
  const instance = create();
  const controller = new AbortController();
  const answer = instance.channel.settings.prompt(
    { kind: "text", title: "Setup" },
    withAbortSignal(controller.signal, context),
  );
  await until(() => telegram.count("getMe") === 1);
  controller.abort();
  assert.equal(await answer, undefined);
  await instance.close();
  assert.equal(await instance.closed, "exit");
  const unused = create();
  await unused.close();
  assert.equal(await unused.closed, "exit");
  stuck.resolve(ok({ id: 100001, is_bot: true }));
});

test("send cancellation is redacted and does not retry a cancelled request", async (t) => {
  const { create, telegram } = await fixture(t);
  const instance = create();
  await instance.channel.start(async () => {});
  const stuck = deferred<Response>();
  telegram.intercept = ({ method }) =>
    method === "sendMessage" ? stuck.promise : undefined;
  const controller = new AbortController();
  const sending = instance.channel.send(
    address,
    { text: "hello" },
    "key",
    withAbortSignal(controller.signal, context),
  );
  const rejected = assert.rejects(
    sending,
    (err: Error) =>
      /cancelled/.test(err.message) && !err.message.includes(token),
  );
  await until(() => telegram.count("sendMessage") === 1);
  controller.abort(new Error(token));
  await rejected;
  assert.equal(telegram.count("sendMessage"), 1);
  stuck.resolve(ok({ message_id: 1002 }));
});

test("empty immediate polling responses are throttled rather than busy-spinning", async (t) => {
  const { create, telegram } = await fixture(t);
  telegram.empty = true;
  const instance = create();
  await instance.channel.start(async () => {});
  await delay(250);
  await instance.close();
  assert(telegram.count("getUpdates") >= 2);
  assert(telegram.count("getUpdates") <= 4);
  assert.equal(telegram.maxPolls, 1);
});
