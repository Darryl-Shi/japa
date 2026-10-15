import { createServer, request, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterEach, beforeAll, expect, test } from "vitest";
import { REQUEST_KEY, type WebuiRequest } from "../extensions/webui/app/src/lib/protocol.ts";
import {
  COOKIE,
  SESSION_SECONDS,
  sessionCookie,
  sessionUser,
  Throttle,
  THROTTLE_FAILURES,
} from "../extensions/webui/auth.ts";
import { DEFAULT_CSP, type Handler, pipeline } from "../extensions/webui/server.ts";
import { hashPassword, newStamp, type UsersResult, type WebuiUser } from "../extensions/webui/users.ts";

const KEY = "session-key-0123456789abcdefghijklmnopqrstuv";
const ALICE_PW = "alice-password";
const BOB_PW = "bob-password-2";
let alice: WebuiUser;
let bob: WebuiUser;
let server: Server | undefined;

beforeAll(async () => {
  const createdAt = new Date().toISOString();
  alice = { name: "alice", createdAt, password: await hashPassword(ALICE_PW), stamp: newStamp() };
  bob = { name: "bob", createdAt, password: await hashPassword(BOB_PW), stamp: newStamp() };
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

/** Serves the pipeline over a fake app on an ephemeral port; returns its base URL and the state it reads. */
async function serve(handler: Handler = (req, res) => res.end(`app ${req.method} ${req.url}`), hosts?: string[]) {
  const state = {
    key: KEY as string | undefined,
    users: { ok: true, users: [alice, bob] } as UsersResult,
    now: Date.now(),
  };
  server = createServer(
    pipeline({
      bind: "127.0.0.1",
      hosts,
      users: async () => state.users,
      sessionKey: async () => state.key,
      handler,
      now: () => state.now,
    }),
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, state };
}

const form = (username: string, password: string) => new URLSearchParams({ username, password });

/** POST /login from the same origin. */
const signIn = (base: string, username: string, password: string) =>
  fetch(`${base}/login`, { method: "POST", headers: { origin: base }, body: form(username, password), redirect: "manual" });

const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0];

/** The status of a request to the server on `port` with the given Host (and Origin) header. */
function statusFor(port: number, host: string, options: { method?: string; origin?: string; body?: string } = {}) {
  const headers: Record<string, string> = { host };
  if (options.origin !== undefined) headers.origin = options.origin;
  // fetch won't send a custom Host; use node:http directly.
  return new Promise<number>((resolve, reject) => {
    const req = request({ port, host: "127.0.0.1", path: "/login", method: options.method ?? "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

test("a foreign Host is refused", async () => {
  const { port } = await serve();
  for (const host of [`evil.example:${port}`, "evil.example", `10.234.31.61.evil.example:${port}`, `127.0.0.1.nip.io:${port}`, "[evil.example]:80"]) {
    expect(await statusFor(port, host), host).toBe(403);
  }
});

test("localhost, 127.0.0.1 and the bind address are accepted on any port", async () => {
  const { port } = await serve();
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `127.0.0.1:${port + 1}`, "localhost:8000", "LOCALHOST", "127.0.0.1"]) {
    expect(await statusFor(port, host), host).toBe(200);
  }
});

test("IP-literal hosts are accepted, on any port", async () => {
  const { port } = await serve();
  for (const host of ["10.234.31.61:7337", "10.234.31.61", "192.168.1.5:8080", "[::1]:8000", "[::1]", "[fe80::1]:7337"]) {
    expect(await statusFor(port, host), host).toBe(200);
  }
  for (const host of ["10.234.31:7337", "::1", "[::1:8000", "999.1.1.1:7337"]) {
    expect(await statusFor(port, host), host).toBe(403);
  }
});

test("names listed in hosts are accepted on any port, with a matching Origin for a POST", async () => {
  const { port } = await serve(undefined, ["Japa.Example.Corp"]);
  for (const host of ["japa.example.corp:7337", "JAPA.example.corp", "japa.example.corp:9999"]) {
    expect(await statusFor(port, host), host).toBe(200);
  }
  expect(await statusFor(port, "other.example.corp:7337")).toBe(403);
  const body = form("alice", ALICE_PW).toString();
  const post = (origin: string) =>
    statusFor(port, "japa.example.corp:7337", { method: "POST", origin, body });
  expect(await post("http://japa.example.corp:7337")).toBe(303);
  expect(await post("http://japa.example.corp:7338")).toBe(403);
  expect(await post("http://evil.example")).toBe(403);
});

test("a POST from an IP-literal host needs the matching Origin", async () => {
  const { port } = await serve();
  const body = form("alice", ALICE_PW).toString();
  const post = (origin: string) => statusFor(port, "10.234.31.61:7337", { method: "POST", origin, body });
  expect(await post("http://10.234.31.61:7337")).toBe(303);
  expect(await post(`http://127.0.0.1:${port}`)).toBe(403);
});

test("a missing Host is refused", async () => {
  const { port } = await serve();
  const status = await new Promise<number>((resolve) => {
    // HTTP/1.0 without a Host header.
    const socket = connect(port, "127.0.0.1", () => socket.write("GET /login HTTP/1.0\r\n\r\n"));
    let data = "";
    socket.on("data", (chunk: Buffer) => (data += chunk.toString()));
    socket.on("close", () => resolve(Number(data.split(" ")[1])));
  });
  expect(status).toBe(403);
});

test("a POST to /login or /logout with a foreign or missing Origin is refused", async () => {
  const { base } = await serve();
  const cookie = cookieOf(await signIn(base, "alice", ALICE_PW))!;
  const body = form("alice", ALICE_PW);
  for (const path of ["/login", "/logout"]) {
    const foreign = await fetch(`${base}${path}`, {
      method: "POST",
      body,
      headers: { origin: "http://evil.example", cookie },
      redirect: "manual",
    });
    expect(foreign.status, path).toBe(403);
    const missing = await fetch(`${base}${path}`, { method: "POST", body, headers: { cookie }, redirect: "manual" });
    expect(missing.status, path).toBe(403);
  }
  // The session survived the refused sign-out.
  expect((await fetch(`${base}/api/update`, { headers: { cookie } })).status).toBe(200);
});

test("without a session the API is 401, pages redirect to sign-in, other methods are 401", async () => {
  const { base } = await serve();
  const api = await fetch(`${base}/api/events`);
  expect(api.status).toBe(401);
  expect(await api.json()).toEqual({ error: "Not signed in" });
  const page = await fetch(`${base}/`, { redirect: "manual" });
  expect(page.status).toBe(303);
  expect(page.headers.get("location")).toBe("/login");
  const post = await fetch(`${base}/api/submit`, { method: "POST", headers: { origin: base }, body: "{}" });
  expect(post.status).toBe(401);
});

test("the sign-in page and static assets are public", async () => {
  const { base } = await serve();
  for (const path of ["/login", "/_app/immutable/x.js", "/favicon.svg", "/robots.txt"]) {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`app GET ${path}`);
  }
});

test("a wrong password and an unknown user get the same generic failure, and no cookie", async () => {
  const { base } = await serve();
  for (const [name, password] of [["alice", "wrong-password"], ["nobody", ALICE_PW], ["alice", ""], ["", ""]]) {
    const res = await signIn(base, name!, password!);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?error=1");
    expect(res.headers.get("set-cookie")).toBeNull();
  }
  // Another user's password isn't alice's.
  expect((await signIn(base, "alice", BOB_PW)).headers.get("location")).toBe("/login?error=1");
});

test("an unknown user costs a scrypt check too", async () => {
  const { base } = await serve();
  await signIn(base, "nobody", "x"); // the dummy hash made once
  const time = async (name: string) => {
    const start = performance.now();
    await signIn(base, name, "wrong-password");
    return performance.now() - start;
  };
  const known = await time("alice");
  const unknown = await time("nobody");
  // Both run scrypt with the same parameters: within a factor, never an instant reply.
  expect(unknown).toBeGreaterThan(known / 4);
});

test("POST /login with a user's password sets the session cookie, which signs in as that user", async () => {
  const seen: (WebuiRequest | undefined)[] = [];
  const { base } = await serve((req, res) => {
    seen.push((req as unknown as Record<symbol, WebuiRequest>)[Symbol.for(REQUEST_KEY)]);
    res.end(`app ${req.method} ${req.url}`);
  });
  const res = await signIn(base, "Alice", ALICE_PW); // names are case-insensitive
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toMatch(new RegExp(`^${COOKIE}=alice\\.\\d+\\.[A-Za-z0-9_-]+;`));
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain(`Max-Age=${SESSION_SECONDS}`);
  const page = await fetch(`${base}/`, { headers: { cookie: cookieOf(res)! } });
  expect(await page.text()).toBe("app GET /");
  expect(seen.at(-1)).toEqual({ user: "alice", users: "some" });
  const api = await fetch(`${base}/api/update`, { headers: { cookie: cookieOf(res)! } });
  expect(api.status).toBe(200);
  // Signed in, the sign-in page sends you on.
  const login = await fetch(`${base}/login`, { headers: { cookie: cookieOf(res)! }, redirect: "manual" });
  expect(login.status).toBe(303);
  expect(login.headers.get("location")).toBe("/");
  // Without a session, the app hears there's no user.
  await fetch(`${base}/login`);
  expect(seen.at(-1)).toEqual({ users: "some" });
});

test("the sign-in page hears whether users exist or the file is unreadable", async () => {
  const seen: (WebuiRequest | undefined)[] = [];
  const { base, state } = await serve((req, res) => {
    seen.push((req as unknown as Record<symbol, WebuiRequest>)[Symbol.for(REQUEST_KEY)]);
    res.end("login page");
  });
  state.users = { ok: true, users: [] };
  await fetch(`${base}/login`);
  expect(seen.at(-1)).toEqual({ users: "none" });
  expect((await signIn(base, "alice", ALICE_PW)).headers.get("location")).toBe("/login?error=1");
  state.users = { ok: false, error: "not valid JSON" };
  await fetch(`${base}/login`);
  expect(seen.at(-1)).toEqual({ users: "unreadable" });
  expect((await signIn(base, "alice", ALICE_PW)).headers.get("location")).toBe("/login?error=1");
});

test("an oversized sign-in body is refused", async () => {
  const { base } = await serve();
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { origin: base },
    body: `username=alice&password=${"x".repeat(10_000)}`,
    redirect: "manual",
  }).catch(() => undefined);
  expect(res === undefined || res.status === 413).toBe(true);
});

test("?token= no longer signs in: it's an ordinary query parameter", async () => {
  const { base } = await serve();
  const res = await fetch(`${base}/?token=anything`, { redirect: "manual" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/login");
  expect(res.headers.get("set-cookie")).toBeNull();
  const cookie = cookieOf(await signIn(base, "alice", ALICE_PW))!;
  const page = await fetch(`${base}/x?token=abc`, { headers: { cookie } });
  expect(await page.text()).toBe("app GET /x?token=abc");
});

test("10 failed sign-ins a minute from one address, then 429 even with the right password, until it passes", async () => {
  const { base, state } = await serve();
  for (let i = 0; i < THROTTLE_FAILURES; i++) {
    expect((await signIn(base, "alice", `wrong-${i}-password`)).status).toBe(303);
  }
  const refused = await signIn(base, "alice", ALICE_PW);
  expect(refused.status).toBe(429);
  expect(refused.headers.get("set-cookie")).toBeNull();
  state.now += 30_000;
  expect((await signIn(base, "alice", ALICE_PW)).status).toBe(429);
  state.now += 30_001;
  const ok = await signIn(base, "alice", ALICE_PW);
  expect(ok.status).toBe(303);
  expect(ok.headers.get("location")).toBe("/");
  // A success clears the count.
  for (let i = 0; i < THROTTLE_FAILURES - 1; i++) await signIn(base, "alice", "wrong-password");
  expect((await signIn(base, "alice", ALICE_PW)).headers.get("location")).toBe("/");
  expect((await signIn(base, "alice", "wrong-password")).status).toBe(303);
});

test("parallel bad sign-ins from one address get at most 10 password checks", async () => {
  const { base } = await serve();
  const replies = await Promise.all(
    Array.from({ length: 40 }, (_, i) => signIn(base, "alice", `guess-${i}-password`).then((r) => r.status)),
  );
  expect(replies.filter((s) => s !== 429)).toHaveLength(THROTTLE_FAILURES);
  expect(replies.filter((s) => s === 429)).toHaveLength(40 - THROTTLE_FAILURES);
  expect((await signIn(base, "alice", ALICE_PW)).status).toBe(429);
});

test("the throttle counts failures per address in a rolling window", () => {
  const t = new Throttle();
  for (let i = 0; i < THROTTLE_FAILURES; i++) t.fail("a", 1000 + i * 1000);
  expect(t.blocked("a", 11_000)).toBe(true);
  expect(t.blocked("b", 11_000)).toBe(false);
  // The first failure (at 1000) leaves the window at 61000.
  expect(t.blocked("a", 61_000)).toBe(false);
  t.clear("a");
  expect(t.blocked("a", 11_000)).toBe(false);
  for (let i = 0; i < THROTTLE_FAILURES; i++) expect(t.reserve("c", 0)).toBe(true);
  expect(t.reserve("c", 0)).toBe(false);
  expect(t.blocked("c", 0)).toBe(true);
});

test("POST /logout clears the cookie and goes to sign-in; it needs a session", async () => {
  const { base } = await serve();
  const cookie = cookieOf(await signIn(base, "alice", ALICE_PW))!;
  const out = await fetch(`${base}/logout`, { method: "POST", headers: { origin: base, cookie }, redirect: "manual" });
  expect(out.status).toBe(303);
  expect(out.headers.get("location")).toBe("/login");
  const cleared = out.headers.get("set-cookie")!;
  expect(cleared).toMatch(new RegExp(`^${COOKIE}=;`));
  expect(cleared).toContain("Max-Age=0");
  // The browser drops the cookie, so its next request has none.
  expect((await fetch(`${base}/api/update`)).status).toBe(401);
  const anonymous = await fetch(`${base}/logout`, { method: "POST", headers: { origin: base }, redirect: "manual" });
  expect(anonymous.status).toBe(401);
});

test("a new password (stamp) or removal ends that user's sessions only; a new key ends all", async () => {
  const { base, state } = await serve();
  const a1 = cookieOf(await signIn(base, "alice", ALICE_PW))!;
  const a2 = cookieOf(await signIn(base, "alice", ALICE_PW))!;
  const b = cookieOf(await signIn(base, "bob", BOB_PW))!;
  const get = async (c: string) => (await fetch(`${base}/api/update`, { headers: { cookie: c } })).status;
  expect([await get(a1), await get(a2), await get(b)]).toEqual([200, 200, 200]);
  // passwd alice: a new hash and stamp.
  const newAlice = { ...alice, password: await hashPassword("new-alice-pw"), stamp: newStamp() };
  state.users = { ok: true, users: [newAlice, bob] };
  expect([await get(a1), await get(a2), await get(b)]).toEqual([401, 401, 200]);
  expect((await signIn(base, "alice", ALICE_PW)).headers.get("location")).toBe("/login?error=1");
  const a3 = cookieOf(await signIn(base, "alice", "new-alice-pw"))!;
  expect(await get(a3)).toBe(200);
  // remove bob
  state.users = { ok: true, users: [newAlice] };
  expect([await get(b), await get(a3)]).toEqual([401, 200]);
  expect((await signIn(base, "bob", BOB_PW)).headers.get("location")).toBe("/login?error=1");
  // An unreadable file: nobody is signed in.
  state.users = { ok: false, error: "not valid JSON" };
  expect(await get(a3)).toBe(401);
  state.users = { ok: true, users: [newAlice] };
  expect(await get(a3)).toBe(200);
  state.key = "another-key";
  expect(await get(a3)).toBe(401);
  state.key = undefined;
  expect(await get(a3)).toBe(401);
});

test("tampered, expired, renamed and old-format cookies are rejected", async () => {
  const { base, state } = await serve();
  const cookie = sessionCookie(KEY, alice, state.now).split(";")[0]!;
  const get = async (c: string) => (await fetch(`${base}/api/update`, { headers: { cookie: c } })).status;
  expect(await get(cookie)).toBe(200);
  expect(await get(`other=1; ${cookie}`)).toBe(200);
  const [name, expiry, mac] = cookie.slice(COOKIE.length + 1).split(".");
  expect(name).toBe("alice");
  expect(await get(`${COOKIE}=alice.${Number(expiry) + 1}.${mac}`)).toBe(401);
  expect(await get(`${COOKIE}=alice.${expiry}.${mac!.slice(0, -2)}AA`)).toBe(401);
  expect(await get(`${COOKIE}=bob.${expiry}.${mac}`)).toBe(401);
  expect(await get(`${COOKIE}=${expiry}.${mac}`)).toBe(401); // the old two-part format
  expect(await get(`${COOKIE}=garbage`)).toBe(401);
  state.now += (SESSION_SECONDS + 1) * 1000;
  expect(await get(cookie)).toBe(401);
});

test("every response carries the security headers", async () => {
  const { base } = await serve();
  for (const res of [await fetch(`${base}/login`), await fetch(`${base}/api/x`), await fetch(`${base}/`, { redirect: "manual" })]) {
    expect(res.headers.get("content-security-policy")).toBe(DEFAULT_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  }
});

test("the app's own headers replace the default CSP", async () => {
  const { base } = await serve((_req, res) => {
    res.writeHead(200, { "content-security-policy": "script-src 'self'" }).end();
  });
  const res = await fetch(`${base}/login`);
  expect(res.headers.get("content-security-policy")).toBe("script-src 'self'");
});

test("session checks", () => {
  const now = Date.now();
  const cookie = sessionCookie(KEY, alice, now).split(";")[0];
  expect(sessionUser(cookie, KEY, [alice, bob], now)).toBe("alice");
  expect(sessionUser(cookie, KEY, [bob], now)).toBeUndefined();
  expect(sessionUser(cookie, KEY, [{ name: "alice", stamp: "other" }], now)).toBeUndefined();
  expect(sessionUser(cookie, undefined, [alice], now)).toBeUndefined();
  expect(sessionUser(cookie, "", [alice], now)).toBeUndefined();
  expect(sessionUser(undefined, KEY, [alice], now)).toBeUndefined();
});

test("a 304 carries no CSP, so the cached page keeps its own", async () => {
  const { base } = await serve((_req, res) => {
    res.writeHead(304, { etag: '"x"' }).end();
  });
  const res = await fetch(`${base}/login`, { headers: { "if-none-match": '"x"' } });
  expect(res.status).toBe(304);
  expect(res.headers.get("content-security-policy")).toBeNull();
});

test("a response written without writeHead still gets the default CSP", async () => {
  const { base } = await serve((_req, res) => {
    res.statusCode = 200;
    res.end("x");
  });
  expect((await fetch(`${base}/login`)).headers.get("content-security-policy")).toBe(DEFAULT_CSP);
});
