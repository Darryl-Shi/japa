// The Desktop panel's websocket: proxied by the web UI's server to the desktop's websockify.
import { mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { DESKTOP_VIEW_KEY, type DesktopViewHandle } from "../extensions/webui/app/src/lib/protocol.ts";
import { webuiExtension } from "../extensions/webui/index.ts";
import { webuiCommand } from "../src/cli/webui-users.ts";
import { bootTest } from "./helpers.ts";

const autostart = process.env.JAPA_WEBUI_AUTOSTART;
beforeAll(() => void delete process.env.JAPA_WEBUI_AUTOSTART);
afterAll(() => void (process.env.JAPA_WEBUI_AUTOSTART = autostart));

const slot = globalThis as Record<symbol, DesktopViewHandle | undefined>;
const VIEW = Symbol.for(DESKTOP_VIEW_KEY);
afterEach(() => void delete slot[VIEW]);

function fakeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), "japa-webui-build-"));
  writeFileSync(join(dir, "handler.js"), `export function handler(req, res) { res.end("fake app"); }\n`);
  return dir;
}

/** A websockify stand-in: records each upgrade request (and the bytes after it), answers 101, then echoes `echo:<bytes>`. */
async function fakeWebsockify() {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = "";
    let upgraded = false;
    socket.on("data", (chunk) => {
      if (upgraded) return void socket.write(`echo:${chunk}`);
      buffered += chunk.toString();
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      requests.push(buffered.slice(0, end));
      upgraded = true;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      const rest = buffered.slice(end + 4);
      if (rest !== "") socket.write(`echo:${rest}`);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, requests, sockets, close: () => new Promise((resolve) => server.close(resolve)) };
}

function handleFor(port: number): DesktopViewHandle {
  return {
    target: () => ({ host: "127.0.0.1", port }),
    password: async () => "vnc-pass",
    status: () => ({ state: "ready", text: "noVNC" }),
    start: () => {},
    enabled: () => true,
  };
}

async function bootWebui() {
  const booted = await bootTest({ extensions: { webui: { port: 0 }, desktop: { autostart: false } } }, [webuiExtension({ buildDir: fakeBuild() })]);
  const line = booted.daemon.status().extensions.find((e) => e.name === "webui")?.status ?? "";
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(line)?.[1]);
  await webuiCommand(booted.home, ["users", "add", "alice", "--password-stdin"], {
    isTTY: false,
    readStdin: async () => "alice-password\n",
    askSecret: async () => {
      throw new Error("no terminal");
    },
    log: () => {},
  });
  const base = `http://127.0.0.1:${port}`;
  const signIn = await fetch(`${base}/login`, {
    method: "POST",
    headers: { origin: base },
    body: new URLSearchParams({ username: "alice", password: "alice-password" }),
    redirect: "manual",
  });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
  return { ...booted, port, cookie };
}

/** Opens a raw connection to the web UI and sends a websocket upgrade; the socket and everything it receives. */
async function upgrade(port: number, headers: Record<string, string>, path = "/api/desktop/ws", extra = "") {
  const socket = connect(port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  let received = "";
  let closed = false;
  socket.on("data", (chunk) => (received += chunk.toString()));
  socket.on("close", () => (closed = true));
  socket.on("error", () => {});
  const all = {
    Host: `127.0.0.1:${port}`,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version": "13",
    ...headers,
  };
  const lines = Object.entries(all).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}`);
  socket.write(`GET ${path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n${extra}`);
  return { socket, received: () => received, closed: () => closed };
}

const statusLine = (text: string) => text.split("\r\n")[0];

test("the desktop websocket is refused without a session, from a foreign origin, or without the desktop", async () => {
  const websockify = await fakeWebsockify();
  const { daemon, port, cookie } = await bootWebui();
  slot[VIEW] = handleFor(websockify.port);
  const origin = `http://127.0.0.1:${port}`;
  const cases: [Record<string, string>, string, string?][] = [
    [{ Origin: origin }, "HTTP/1.1 401 Unauthorized"],
    [{ Origin: origin, Cookie: "japa_webui_session=1.forged" }, "HTTP/1.1 401 Unauthorized"],
    [{ Origin: "http://evil.example", Cookie: cookie }, "HTTP/1.1 403 Forbidden"],
    [{ Cookie: cookie }, "HTTP/1.1 403 Forbidden"], // no Origin
    [{ Origin: "http://evil.example", Cookie: cookie, Host: "evil.example" }, "HTTP/1.1 403 Forbidden"],
    [{ Origin: origin, Cookie: cookie }, "HTTP/1.1 404 Not Found", "/api/events"],
  ];
  for (const [headers, expected, path] of cases) {
    const c = await upgrade(port, headers, path);
    await vi.waitFor(() => expect(c.closed()).toBe(true));
    expect(statusLine(c.received()), JSON.stringify(headers)).toBe(expected);
  }
  delete slot[VIEW];
  const none = await upgrade(port, { Origin: origin, Cookie: cookie });
  await vi.waitFor(() => expect(none.closed()).toBe(true));
  expect(statusLine(none.received())).toBe("HTTP/1.1 503 Service Unavailable");
  expect(websockify.requests).toEqual([]);
  await daemon.close();
  await websockify.close();
});

test("a signed-in, same-origin upgrade is piped to websockify both ways, and the surface stopping closes it", async () => {
  const websockify = await fakeWebsockify();
  const { daemon, port, cookie } = await bootWebui();
  slot[VIEW] = handleFor(websockify.port);
  const c = await upgrade(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie }, "/api/desktop/ws", "early");
  await vi.waitFor(() => expect(c.received()).toContain("echo:early"));
  expect(statusLine(c.received())).toBe("HTTP/1.1 101 Switching Protocols");
  c.socket.write("frame-1");
  await vi.waitFor(() => expect(c.received()).toContain("echo:frame-1"));

  // What websockify got: its own Host, the websocket headers, and neither the session cookie nor the origin.
  const [request] = websockify.requests;
  expect(request).toMatch(/^GET \/websockify HTTP\/1\.1\r\n/);
  expect(request).toContain(`Host: 127.0.0.1:${websockify.port}`);
  expect(request).toContain("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==");
  expect(request).toContain("Upgrade: websocket");
  expect(request).not.toMatch(/cookie|origin|japa_webui_session/i);

  await daemon.close();
  await vi.waitFor(() => expect(c.closed()).toBe(true));
  await vi.waitFor(() => expect(websockify.sockets.size).toBe(0));
  await websockify.close();
});

test("closing the panel's websocket closes the upstream connection", async () => {
  const websockify = await fakeWebsockify();
  const { daemon, port, cookie } = await bootWebui();
  slot[VIEW] = handleFor(websockify.port);
  const c = await upgrade(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
  await vi.waitFor(() => expect(websockify.sockets.size).toBe(1));
  c.socket.destroy();
  await vi.waitFor(() => expect(websockify.sockets.size).toBe(0));
  await daemon.close();
  await websockify.close();
});

test("websockify not listening reads 502", async () => {
  const websockify = await fakeWebsockify();
  await websockify.close(); // its port is now free
  const { daemon, port, cookie } = await bootWebui();
  slot[VIEW] = handleFor(websockify.port);
  const c = await upgrade(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
  await vi.waitFor(() => expect(c.closed()).toBe(true));
  expect(statusLine(c.received())).toBe("HTTP/1.1 502 Bad Gateway");
  await daemon.close();
});

test("the bridge's desktop view: unavailable without the handle; state and password with it; start", async () => {
  const { daemon } = await bootWebui();
  const bridge = (globalThis as Record<symbol, import("../extensions/webui/app/src/lib/protocol.ts").WebuiBridge>)[
    Symbol.for("japa.webui.bridge")
  ]!;
  delete slot[VIEW]; // the packaged desktop's
  expect(await bridge.desktop()).toEqual({ available: false });
  expect(bridge.startDesktop()).toBe(false);
  let started = 0;
  slot[VIEW] = { ...handleFor(1), status: () => ({ state: "building", text: "Building the desktop's image…" }), start: () => void started++ };
  expect(await bridge.desktop()).toEqual({ available: true, state: "building", text: "Building the desktop's image…", password: "vnc-pass" });
  expect(bridge.startDesktop()).toBe(true);
  expect(started).toBe(1);
  await daemon.close();
});

test("a new password or a removed user (signed out) closes their open proxied connections", async () => {
  const { createServer: createHttp } = await import("node:http");
  const { desktopProxy } = await import("../extensions/webui/server.ts");
  const { sessionCookie } = await import("../extensions/webui/auth.ts");
  const websockify = await fakeWebsockify();
  const key = "session-key";
  let users = [
    { name: "alice", stamp: "stamp-a" },
    { name: "bob", stamp: "stamp-b" },
  ];
  const proxy = desktopProxy({
    bind: "127.0.0.1",
    users: async () => ({ ok: true, users: users as never }),
    sessionKey: async () => key,
    desktop: () => handleFor(websockify.port),
    recheckMs: 50,
  });
  const server = createHttp((_req, res) => res.end());
  server.on("upgrade", proxy.upgrade);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const cookieOf = (u: { name: string; stamp: string }) => sessionCookie(key, u, Date.now()).split(";")[0]!;
  const a = await upgrade(port, { Origin: origin, Cookie: cookieOf(users[0]!) });
  const b = await upgrade(port, { Origin: origin, Cookie: cookieOf(users[1]!) });
  await vi.waitFor(() => expect(websockify.sockets.size).toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect([a.closed(), b.closed()]).toEqual([false, false]); // still signed in
  users = [{ name: "alice", stamp: "new-stamp" }, users[1]!]; // passwd alice
  await vi.waitFor(() => expect(a.closed()).toBe(true));
  await vi.waitFor(() => expect(websockify.sockets.size).toBe(1));
  expect(b.closed()).toBe(false);
  users = [users[0]!]; // remove bob
  await vi.waitFor(() => expect(b.closed()).toBe(true));
  await vi.waitFor(() => expect(websockify.sockets.size).toBe(0));
  proxy.close();
  await new Promise((resolve) => server.close(resolve));
  await websockify.close();
});

test("with the desktop turned off in Settings, the panel reads unavailable, Start does nothing and the websocket is refused", async () => {
  const websockify = await fakeWebsockify();
  const { daemon, port, cookie } = await bootWebui();
  const bridge = (globalThis as Record<symbol, import("../extensions/webui/app/src/lib/protocol.ts").WebuiBridge>)[
    Symbol.for("japa.webui.bridge")
  ]!;
  const packaged = slot[VIEW]!; // the packaged desktop's, loaded with autostart off
  expect(packaged.enabled()).toBe(true);
  expect((await bridge.desktop()).available).toBe(true);
  expect(await bridge.settings!.set("extensions.desktop.enabled", false)).toMatch(/^Set extensions\.desktop\.enabled/);
  expect(slot[VIEW]).toBe(packaged); // still loaded, only off
  expect(await bridge.desktop()).toEqual({ available: false });
  expect(bridge.startDesktop()).toBe(false);
  expect(packaged.status().state).toBe("stopped");
  slot[VIEW] = { ...handleFor(websockify.port), enabled: () => false };
  const c = await upgrade(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
  await vi.waitFor(() => expect(c.closed()).toBe(true));
  expect(statusLine(c.received())).toBe("HTTP/1.1 503 Service Unavailable");
  expect(websockify.requests).toEqual([]);
  await daemon.close();
  await websockify.close();
});
