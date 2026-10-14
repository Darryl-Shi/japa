import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { BRIDGE_KEY, type LiveEvent, type WebuiBridge } from "../extensions/webui/app/src/lib/protocol.ts";
import { webuiExtension } from "../extensions/webui/index.ts";
import { webuiCommand } from "../src/cli/webui-users.ts";
import { boot } from "../src/kernel/boot.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { bootErrors, bootTest, probe, REPO_EXTENSIONS, testKit } from "./helpers.ts";
import { texts } from "./jobs-helpers.ts";

// The suite turns the web UI off (vitest.config.ts); this file is about it.
const autostart = process.env.JAPA_WEBUI_AUTOSTART;
beforeAll(() => void delete process.env.JAPA_WEBUI_AUTOSTART);
afterAll(() => void (process.env.JAPA_WEBUI_AUTOSTART = autostart));

const REAL_BUILD = fileURLToPath(new URL("../extensions/webui/build", import.meta.url));
const LINE = /^http:\/\/127\.0\.0\.1:(\d+) — (.+)$/;
const NO_USERS = "no users yet: run japa webui users add <name>";

/** A stand-in for the app's build: a handler that serves submit, events and status through the bridge. */
function fakeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), "japa-webui-build-"));
  writeFileSync(
    join(dir, "handler.js"),
    `export async function handler(req, res) {
  const bridge = globalThis[Symbol.for(${JSON.stringify(BRIDGE_KEY)})];
  if (req.url === "/api/submit" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { text, mode, id } = JSON.parse(body);
    await bridge.submit(text, mode, id);
    return res.writeHead(204).end();
  }
  if (req.url === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const unsubscribe = bridge.subscribe((e) => res.write("data: " + JSON.stringify(e) + "\\n\\n"), () => res.end());
    req.on("close", unsubscribe);
    return;
  }
  if (req.url === "/api/status") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(bridge.status()));
  res.end("fake app");
}
`,
  );
  return dir;
}

const webuiStatus = (daemon: Awaited<ReturnType<typeof bootTest>>["daemon"]) =>
  daemon.status().extensions.find((e) => e.name === "webui");

/** Runs `japa webui users <args>` on `home` in-process, the password given as with --password-stdin. */
async function users(home: string, args: string[], password = "") {
  const out: string[] = [];
  await webuiCommand(home, ["users", ...args], {
    isTTY: false,
    readStdin: async () => `${password}\n`,
    askSecret: async () => {
      throw new Error("no terminal");
    },
    log: (t) => out.push(t),
  });
  return out.join("\n");
}

const portOf = (line: string) => Number(LINE.exec(line)?.[1]);

/** Signs in through the web UI at `base`; the session cookie, or undefined. */
async function signIn(base: string, username: string, password: string): Promise<string | undefined> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { origin: base },
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
  });
  return res.headers.get("set-cookie")?.split(";")[0];
}

/** Boots with the web UI on an ephemeral port, serving `buildDir`, with user alice; its base URL and her cookie. */
async function bootWebui(buildDir = fakeBuild(), extra: JapaExtension[] = []) {
  const booted = await bootTest({ extensions: { webui: { port: 0 } } }, [webuiExtension({ buildDir }), ...extra]);
  await users(booted.home, ["add", "alice", "--password-stdin"], "alice-password");
  const line = webuiStatus(booted.daemon)?.status ?? "";
  const port = portOf(line);
  const base = `http://127.0.0.1:${port}`;
  const cookie = (await signIn(base, "alice", "alice-password"))!;
  return { ...booted, line, port, base, cookie };
}

const tilde = (path: string) => {
  const h = homedir();
  return path.startsWith(h + sep) ? `~${path.slice(h.length)}` : path;
};

test("a fresh home: no users yet, a generated session key, and no token", async () => {
  const { daemon, home } = await bootTest({ extensions: { webui: { port: 0 } } }, [webuiExtension({ buildDir: fakeBuild() })]);
  const line = webuiStatus(daemon)?.status ?? "";
  expect(line).toBe(`http://127.0.0.1:${portOf(line)} — ${NO_USERS}`);
  expect(portOf(line)).toBeGreaterThan(0);
  expect(existsSync(join(home, "secrets", "webui.token"))).toBe(false);
  const key = readFileSync(join(home, "secrets", "webui.session-key"), "utf8");
  expect(key).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  expect(statSync(join(home, "secrets", "webui.session-key")).mode & 0o777).toBe(0o600);
  expect(webuiStatus(daemon)).toMatchObject({ summary: "Chat with japa in your browser", state: "on" });
  expect(bootErrors(daemon)).toEqual([]);
  await daemon.close();
});

test("the status line follows the users file without a restart, and never shows secrets", async () => {
  const { daemon, home, line, base, cookie } = await bootWebui();
  const url = `http://127.0.0.1:${portOf(line)}`;
  expect(line).toBe(`${url} — sign in as a web UI user (1 user)`);
  await users(home, ["add", "bob", "--password-stdin"], "bob-password");
  expect(webuiStatus(daemon)?.status).toBe(`${url} — sign in as a web UI user (2 users)`);
  const file = join(home, "webui", "users.json");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.slice(0, -10));
  const broken = webuiStatus(daemon)?.status ?? "";
  expect(broken).toBe(`${url} — can't read ${tilde(file)}: not valid JSON`);
  // Nobody can sign in meanwhile.
  expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);
  writeFileSync(file, text);
  expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200);
  const stored = JSON.parse(text) as { users: { password: { key: string; salt: string }; stamp: string }[] };
  const key = readFileSync(join(home, "secrets", "webui.session-key"), "utf8");
  for (const status of [line, broken, webuiStatus(daemon)?.status ?? ""]) {
    for (const u of stored.users) for (const secret of [u.password.key, u.password.salt, u.stamp]) {
      expect(status).not.toContain(secret);
    }
    expect(status).not.toContain(key);
    expect(status).not.toContain("alice-password");
  }
  await users(home, ["remove", "alice"]);
  await users(home, ["remove", "bob"]);
  expect(webuiStatus(daemon)?.status).toBe(`${url} — ${NO_USERS}`);
  await daemon.close();
});

test("signing in with a password, passwd and remove end only that user's sessions, sessions survive a restart", async () => {
  const buildDir = fakeBuild();
  const kit = testKit();
  const { daemon, home, base, cookie: alice1 } = await bootWebui(buildDir);
  await users(home, ["add", "bob", "--password-stdin"], "bob-password");
  const alice2 = (await signIn(base, "alice", "alice-password"))!;
  const bob = (await signIn(base, "BOB", "bob-password"))!;
  expect(await signIn(base, "alice", "wrong-password")).toBeUndefined();
  expect(await signIn(base, "nobody", "alice-password")).toBeUndefined();
  const status = async (b: string, c: string) => (await fetch(`${b}/api/status`, { headers: { cookie: c } })).status;
  expect([await status(base, alice1), await status(base, alice2), await status(base, bob)]).toEqual([200, 200, 200]);

  await users(home, ["passwd", "alice", "--password-stdin"], "alice-new-password");
  expect([await status(base, alice1), await status(base, alice2), await status(base, bob)]).toEqual([401, 401, 200]);
  expect(await signIn(base, "alice", "alice-password")).toBeUndefined();
  const alice3 = (await signIn(base, "alice", "alice-new-password"))!;
  expect(await status(base, alice3)).toBe(200);

  // A restart keeps them signed in.
  await daemon.close();
  const again = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, webuiExtension({ buildDir })] });
  const base2 = `http://127.0.0.1:${portOf(webuiStatus(again)?.status ?? "")}`;
  expect([await status(base2, alice3), await status(base2, bob)]).toEqual([200, 200]);

  await users(home, ["remove", "bob"]);
  expect([await status(base2, alice3), await status(base2, bob)]).toEqual([200, 401]);
  expect(await signIn(base2, "bob", "bob-password")).toBeUndefined();
  await again.close();
});

test("a leftover webui.token is ignored and left alone", async () => {
  const buildDir = fakeBuild();
  const { daemon, home } = await bootTest({ extensions: { webui: { port: 0 } } }, [webuiExtension({ buildDir })], undefined, {
    "webui.token": "my-old-token",
  });
  expect(readFileSync(join(home, "secrets", "webui.token"), "utf8")).toBe("my-old-token");
  const base = `http://127.0.0.1:${portOf(webuiStatus(daemon)?.status ?? "")}`;
  const res = await fetch(`${base}/?token=my-old-token`, { redirect: "manual" });
  expect(res.headers.get("location")).toBe("/login");
  expect(res.headers.get("set-cookie")).toBeNull();
  await daemon.close();
});

test("an existing session key is kept", async () => {
  const { daemon, home } = await bootTest(
    { extensions: { webui: { port: 0 } } },
    [webuiExtension({ buildDir: fakeBuild() })],
    undefined,
    { "webui.session-key": "my-own-session-key-0123456789abcdef" },
  );
  expect(readFileSync(join(home, "secrets", "webui.session-key"), "utf8")).toBe("my-own-session-key-0123456789abcdef");
  await daemon.close();
});

test("enabled: false starts no server and shows no status line", async () => {
  const { daemon, home } = await bootTest({ extensions: { webui: { port: 0, enabled: false } } }, [
    webuiExtension({ buildDir: fakeBuild() }),
  ]);
  expect(webuiStatus(daemon)).toMatchObject({ state: "off" });
  expect(webuiStatus(daemon)?.status).toBeUndefined();
  expect(existsSync(join(home, "secrets", "webui.session-key"))).toBe(false);
  await daemon.close();
});

test("without a build the daemon still boots and the line says how to build", async () => {
  const empty = mkdtempSync(join(tmpdir(), "japa-webui-empty-"));
  const { daemon } = await bootTest({ extensions: { webui: { port: 0 } } }, [webuiExtension({ buildDir: empty })]);
  expect(webuiStatus(daemon)?.status).toMatch(/^not built — run npm run build in \/.+/);
  expect(bootErrors(daemon)).toEqual([]);
  await daemon.close();
});

test("a port in use is named in the line, and the daemon still boots", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as AddressInfo).port;
  const { daemon } = await bootTest({ extensions: { webui: { port } } }, [webuiExtension({ buildDir: fakeBuild() })]);
  expect(webuiStatus(daemon)?.status).toBe(`can't listen on 127.0.0.1:${port}: address already in use`);
  expect(bootErrors(daemon)).toEqual([]);
  await daemon.close();
  blocker.close();
});

test("the hosts setting adds DNS names the server answers to", async () => {
  const { daemon } = await bootTest({ extensions: { webui: { port: 0, hosts: ["japa.example.corp"] } } }, [
    webuiExtension({ buildDir: fakeBuild() }),
  ]);
  expect(bootErrors(daemon)).toEqual([]);
  const port = portOf(webuiStatus(daemon)?.status ?? "");
  const statusFor = (host: string) =>
    new Promise<number>((resolve, reject) =>
      httpRequest({ port, host: "127.0.0.1", path: "/login", headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      })
        .on("error", reject)
        .end(),
    );
  expect(await statusFor("japa.example.corp:7337")).toBe(200);
  expect(await statusFor("10.234.31.61:7337")).toBe(200);
  expect(await statusFor("other.example.corp:7337")).toBe(403);
  await daemon.close();
});

test("a web submission reaches the CoS from webui/web, once per id, and its reply streams live", async () => {
  const { extension, surface } = probe();
  const { daemon, faux, home, base, cookie } = await bootWebui(fakeBuild(), [extension]);
  const raw: AgentEvent[] = [];
  const watch = await surface().root.events((events) => raw.push(...events));

  /** A live stream with `c`, as a tab opens one: the events it has had, and its reading. */
  async function stream(c: string) {
    const events = await fetch(`${base}/api/events`, { headers: { cookie: c } });
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    const seen: LiveEvent[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of events.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;
        for (const part of parts) seen.push(JSON.parse(part.slice("data: ".length)));
      }
    })();
    await vi.waitFor(() => expect(seen[0]?.type).toBe("snapshot"));
    return { seen, reading };
  }
  const { seen: live, reading } = await stream(cookie);
  // Another user, signed in at the same time, shares the conversation.
  await users(home, ["add", "bob", "--password-stdin"], "bob-password");
  const bob = await stream((await signIn(base, "bob", "bob-password"))!);

  faux.setResponses([fauxAssistantMessage([fauxText("Hi from japa")])]);
  const submit = (id: string) =>
    fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello web", mode: "followUp", id }),
    });
  expect((await submit("abc-1")).status).toBe(204);
  await vi.waitFor(() => expect(JSON.stringify(raw)).toContain('"requestId":"surface:webui:web:abc-1"'));
  await vi.waitFor(() => expect(JSON.stringify(live)).toContain("Hi from japa"));
  expect(live).toContainEqual({ type: "lines", lines: [{ kind: "user", text: "hello web" }] });
  expect(live).toContainEqual({ type: "busy", busy: false });
  await vi.waitFor(() => expect(JSON.stringify(bob.seen)).toContain("Hi from japa"));
  expect(bob.seen).toContainEqual({ type: "lines", lines: [{ kind: "user", text: "hello web" }] });

  expect((await submit("abc-1")).status).toBe(204);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await texts(daemon.root, "user")).filter((t) => t === "hello web")).toHaveLength(1);

  // Closing the daemon ends the stream.
  await watch.stop();
  await daemon.close();
  await reading.catch(() => {});
  await bob.reading.catch(() => {});
});

test("the bridge subscription sees the CoS's reply", async () => {
  const { daemon, faux } = await bootWebui();
  const bridge = (globalThis as Record<symbol, WebuiBridge>)[Symbol.for(BRIDGE_KEY)]!;
  const seen: LiveEvent[] = [];
  let closed = false;
  bridge.subscribe((e) => seen.push(e), () => (closed = true));
  faux.setResponses([fauxAssistantMessage([fauxText("Streamed reply")])]);
  await bridge.submit("hi", "followUp", "id-2");
  await vi.waitFor(() => expect(JSON.stringify(seen)).toContain("Streamed reply"));
  await daemon.close();
  expect(closed).toBe(true);
});

test.skipIf(!existsSync(join(REAL_BUILD, "handler.js")))("the real build serves pages with SvelteKit's CSP", async () => {
  const booted = await bootWebui(REAL_BUILD);
  const { daemon, base, cookie } = booted;
  const { home } = booted;
  const login = await fetch(`${base}/login`);
  expect(login.status).toBe(200);
  expect(login.headers.get("content-type")).toContain("text/html");
  expect(login.headers.get("content-security-policy")).toContain("script-src 'self'");
  const form = await login.text();
  expect(form).toContain('autocomplete="username"');
  expect(form).toContain('autocomplete="current-password"');
  expect(form).toContain('name="password"');
  expect(form).not.toContain("Wrong username or password.");
  expect(await (await fetch(`${base}/login?error=1`)).text()).toContain("Wrong username or password.");
  const page = await fetch(`${base}/`, { headers: { cookie } });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self' 'sha256-/);
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  // The chat page's data carries the signed-in user's name.
  const data = await fetch(`${base}/__data.json`, { headers: { cookie } });
  expect(data.status).toBe(200);
  expect(await data.text()).toContain('"alice"');
  // With no users, the sign-in page says how to add one.
  await users(home, ["remove", "alice"]);
  const empty = await (await fetch(`${base}/login`)).text();
  expect(empty).toContain("No web UI users yet.");
  expect(empty).toContain("japa webui users add &lt;name>");
  expect(empty).not.toContain('name="password"');
  await daemon.close();
});
