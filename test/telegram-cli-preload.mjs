// Child-process fixture only: simulate Telegram without opening any network connection.
const chat = { id: 42, type: "private" };
const bot = { id: 123456, is_bot: true, username: "japa_offline_test_bot" };
const messages = new Map();
const updates = [];
let messageId = 100;
let updateId = 1000;
let pending;
let getMeCalls = 0;

function report(event) {
  if (process.connected) process.send(event);
}
function json(result) {
  return Response.json({ ok: true, result });
}
function deliver() {
  if (!pending) return;
  const available = updates.filter(
    (update) => update.update_id >= pending.offset,
  );
  if (!available.length) return;
  const current = pending;
  pending = undefined;
  current.finish(json(available));
}
process.on("message", (command) => {
  if (command.type !== "telegram-update") return;
  updates.push({
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: { id: 42, is_bot: false, first_name: "Offline owner" },
      text: command.text,
      ...(command.replyTo
        ? { reply_to_message: messages.get(command.replyTo) }
        : {}),
    },
  });
  deliver();
});
// IPC is only our test control plane, not a reason to keep the application alive.
process.channel?.unref();

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (
    url.origin !== "https://api.telegram.org" ||
    !url.pathname.startsWith(`/bot123456:${"x".repeat(35)}/`)
  ) {
    report({ type: "unexpected-network" });
    throw new Error("Unexpected network request in offline CLI test");
  }
  options.signal?.throwIfAborted();
  const method = url.pathname.split("/").at(-1);
  const body = options.body ? JSON.parse(String(options.body)) : {};
  if (method === "getMe") {
    report({ type: "getMe", count: ++getMeCalls });
    return json(bot);
  }
  if (method === "getWebhookInfo") return json({ url: "" });
  if (method === "sendMessage") {
    const message = {
      message_id: ++messageId,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: bot,
      text: body.text,
    };
    messages.set(message.message_id, message);
    report({ type: "sent", message, prompt: !!body.reply_markup?.force_reply });
    return json(message);
  }
  if (method === "deleteMessage") return json(true);
  if (method === "getUpdates") {
    if (pending) throw new Error("Concurrent Telegram polling loops");
    return new Promise((resolve, reject) => {
      const offset = body.offset ?? 0;
      let timer;
      const clear = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (pending?.finish === finish) pending = undefined;
      };
      const finish = (response) => {
        clear();
        resolve(response);
      };
      const abort = () => {
        clear();
        reject(new DOMException("Request cancelled", "AbortError"));
      };
      pending = { offset, finish };
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => finish(json([])),
        Math.max(1, Number(body.timeout ?? 0) * 1000),
      );
      if (options.signal?.aborted) abort();
      else deliver();
    });
  }
  report({ type: "unexpected-method", method });
  throw new Error("Unexpected Telegram method in offline CLI test");
};
