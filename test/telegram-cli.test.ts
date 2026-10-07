import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

type Event = {
  type: string;
  count?: number;
  prompt?: boolean;
  message?: { message_id: number; text: string };
};

async function launch(t: TestContext, configured: boolean) {
  const home = await mkdtemp(join(tmpdir(), "japa-telegram-cli-"));
  const token = `123456:${"x".repeat(35)}`;
  const key = "offline-zai-key-never-used-for-inference";
  await writeFile(
    join(home, "telegram.json"),
    JSON.stringify({ token, chatId: "42" }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      resolve("test/telegram-cli-preload.mjs"),
      resolve("src/cli.ts"),
      "--telegram",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        JAPA_HOME: home,
        ...(configured
          ? {
              ZAI_API_KEY: key,
              JAPA_MODEL: "zai/glm-5.3",
              JAPA_WORKER_MODEL: "zai/glm-5.3-flash",
            }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  // Telegram must remain available with stdin closed (as under systemd).
  child.stdin!.end();
  let output = "";
  let ready = 0;
  let exited = false;
  const events: Event[] = [];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
    const count = output.match(/Japa is ready on Telegram/g)?.length ?? 0;
    if (count > ready) events.push({ type: "ready", count });
    ready = count;
    changed();
  });
  child.stderr!.on("data", (chunk) => {
    output += String(chunk);
    changed();
  });
  child.on("message", (event) => {
    events.push(event as Event);
    changed();
  });
  const closed = new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      exited = true;
      changed();
      resolveCode(code);
    });
  });
  t.after(async () => {
    if (!exited && !child.killed) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
      await rm(home, { recursive: true, force: true });
    }
  });

  function waitFor(predicate: (event: Event) => boolean): Promise<Event> {
    return new Promise((resolveEvent, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      const check = () => {
        const event = events.find(predicate);
        if (event) {
          cleanup();
          resolveEvent(event);
        } else if (exited) {
          cleanup();
          reject(new Error(`CLI exited before expected event: ${output}`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`CLI event timed out: ${output}`));
      }, 15_000);
      listeners.add(check);
      check();
    });
  }
  return {
    home,
    events,
    waitFor,
    update(text: string, replyTo?: number) {
      child.send({ type: "telegram-update", text, replyTo });
    },
    async stop() {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        assert.equal(await closed, 0, output);
      } finally {
        clearTimeout(timer);
      }
      assert(!output.includes(token));
      assert(!output.includes(key));
      assert(!events.some((event) => event.type.startsWith("unexpected-")));
    },
  };
}

test("Telegram CLI uses shared setup, resumes after cancellation, and ignores stdin EOF", async (t) => {
  const app = await launch(t, true);
  await app.waitFor((event) => event.type === "ready" && event.count === 1);
  const previous = await readFile(join(app.home, "settings.json"), "utf8");
  app.update("/settings");
  const prompt = await app.waitFor(
    (event) => event.type === "sent" && !!event.prompt,
  );
  app.update("/cancel", prompt.message!.message_id);
  await app.waitFor((event) => event.type === "ready" && event.count === 2);
  assert.equal(
    await readFile(join(app.home, "settings.json"), "utf8"),
    previous,
  );
  assert((await readdir(app.home)).includes("japa.sqlite"));
  assert.equal(await readFile(join(app.home, "MEMORY.md"), "utf8"), "");
  await app.stop();
});

test("Telegram remains reachable for settings after unconfigured setup is cancelled", async (t) => {
  const app = await launch(t, false);
  const first = await app.waitFor(
    (event) => event.type === "sent" && !!event.prompt,
  );
  app.update("/cancel", first.message!.message_id);
  await app.waitFor(
    (event) => event.message?.text.includes("No model is connected") ?? false,
  );
  assert(!(await readdir(app.home)).includes("japa.sqlite"));
  app.update("/settings");
  const next = await app.waitFor(
    (event) =>
      event.type === "sent" &&
      !!event.prompt &&
      event.message!.message_id > first.message!.message_id,
  );
  app.update("/cancel", next.message!.message_id);
  await app.waitFor(
    (event) =>
      (event.message?.text.includes("No model is connected") ?? false) &&
      event.message!.message_id > next.message!.message_id,
  );
  assert(!(await readdir(app.home)).includes("japa.sqlite"));
  await app.stop();
});
