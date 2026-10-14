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
import type { JapaExtension } from "../src/kernel/extension.ts";
import { bootErrors, bootTest, probe } from "./helpers.ts";
import { texts } from "./jobs-helpers.ts";

// The suite turns the web UI off (vitest.config.ts); this file is about it.
const autostart = process.env.JAPA_WEBUI_AUTOSTART;
beforeAll(() => void delete process.env.JAPA_WEBUI_AUTOSTART);
afterAll(() => void (process.env.JAPA_WEBUI_AUTOSTART = autostart));

const REAL_BUILD = fileURLToPath(new URL("../extensions/webui/build", import.meta.url));
const LINE = /^http:\/\/127\.0\.0\.1:(\d+) — sign in with the token in (.+)$/;

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

/** Boots with the web UI on an ephemeral port, serving `buildDir`; its base URL and a signed-in cookie. */
async function bootWebui(buildDir = fakeBuild(), extra: JapaExtension[] = []) {
  const booted = await bootTest({ extensions: { webui: { port: 0 } } }, [webuiExtension({ buildDir }), ...extra]);
  const line = webuiStatus(booted.daemon)?.status ?? "";
  const port = Number(LINE.exec(line)?.[1]);
  const base = `http://127.0.0.1:${port}`;
  const token = readFileSync(join(booted.home, "secrets", "webui.token"), "utf8");
  const signIn = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
  return { ...booted, line, port, base, token, cookie };
}

test("starts on the configured port, generates a private token, and shows where it is", async () => {
  const { daemon, home, line, port, token, base, cookie } = await bootWebui();
  expect(line).toMatch(LINE);
  expect(port).toBeGreaterThan(0);
  const tokenPath = join(home, "secrets", "webui.token");
  const h = homedir();
  const shown = tokenPath.startsWith(h + sep) ? `~${tokenPath.slice(h.length)}` : tokenPath;
  expect(LINE.exec(line)![2]).toBe(shown);
  expect(line).not.toContain(token);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  expect(statSync(join(home, "secrets", "webui.token")).mode & 0o777).toBe(0o600);
  expect(webuiStatus(daemon)).toMatchObject({ summary: "Chat with japa in your browser", state: "on" });
  expect(bootErrors(daemon)).toEqual([]);
  const status = await fetch(`${base}/api/status`, { headers: { cookie } });
  expect((await status.json()).extensions.map((e: { name: string }) => e.name)).toContain("webui");
  await daemon.close();
  await expect(fetch(base)).rejects.toThrow();
  expect((globalThis as Record<symbol, unknown>)[Symbol.for(BRIDGE_KEY)]).toBeUndefined();
});

test("an existing token is kept", async () => {
  const buildDir = fakeBuild();
  const { daemon, home } = await bootTest({ extensions: { webui: { port: 0 } } }, [webuiExtension({ buildDir })], undefined, {
    "webui.token": "my-own-token",
  });
  expect(readFileSync(join(home, "secrets", "webui.token"), "utf8")).toBe("my-own-token");
  await daemon.close();
});

test("enabled: false starts no server and shows no status line", async () => {
  const { daemon, home } = await bootTest({ extensions: { webui: { port: 0, enabled: false } } }, [
    webuiExtension({ buildDir: fakeBuild() }),
  ]);
  expect(webuiStatus(daemon)).toMatchObject({ state: "off" });
  expect(webuiStatus(daemon)?.status).toBeUndefined();
  expect(existsSync(join(home, "secrets", "webui.token"))).toBe(false);
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
  const port = Number(LINE.exec(webuiStatus(daemon)?.status ?? "")?.[1]);
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
  const { daemon, faux, base, cookie } = await bootWebui(fakeBuild(), [extension]);
  const raw: AgentEvent[] = [];
  const watch = await surface().root.events((events) => raw.push(...events));

  // A live stream, as a tab opens one.
  const events = await fetch(`${base}/api/events`, { headers: { cookie } });
  expect(events.headers.get("content-type")).toBe("text/event-stream");
  const live: LiveEvent[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of events.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;
      for (const part of parts) live.push(JSON.parse(part.slice("data: ".length)));
    }
  })();
  await vi.waitFor(() => expect(live[0]?.type).toBe("snapshot"));

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

  expect((await submit("abc-1")).status).toBe(204);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await texts(daemon.root, "user")).filter((t) => t === "hello web")).toHaveLength(1);

  // Closing the daemon ends the stream.
  await watch.stop();
  await daemon.close();
  await reading.catch(() => {});
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
  const { daemon, base, cookie } = await bootWebui(REAL_BUILD);
  const login = await fetch(`${base}/login`);
  expect(login.status).toBe(200);
  expect(login.headers.get("content-type")).toContain("text/html");
  expect(login.headers.get("content-security-policy")).toContain("script-src 'self'");
  const page = await fetch(`${base}/`, { headers: { cookie } });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self' 'sha256-/);
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  await daemon.close();
});
