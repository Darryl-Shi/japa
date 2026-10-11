import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { COOKIE, SESSION_SECONDS, sessionCookie, tokenMatches, validSession } from "../extensions/webui/auth.ts";
import { DEFAULT_CSP, type Handler, pipeline } from "../extensions/webui/server.ts";

const TOKEN = "right-token-0123456789abcdefghijklmnopqrstuv";
let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

/** Serves the pipeline over a fake app on an ephemeral port; returns its base URL and the token holder. */
async function serve(handler: Handler = (req, res) => res.end(`app ${req.method} ${req.url}`)) {
  const state = { token: TOKEN as string | undefined, now: Date.now() };
  let port = 0;
  server = createServer(
    pipeline({ bind: "127.0.0.1", port: () => port, token: async () => state.token, handler, now: () => state.now }),
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, state };
}

const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0];

test("a foreign Host is refused", async () => {
  const { port } = await serve();
  // fetch won't send a custom Host; use node:http directly.
  const status = await new Promise<number>((resolve) =>
    request({ port, host: "127.0.0.1", path: "/login", headers: { host: `evil.example:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).end(),
  );
  expect(status).toBe(403);
});

test("localhost and 127.0.0.1 with the port are accepted as hosts", async () => {
  const { port } = await serve();
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `127.0.0.1:${port + 1}`]) {
    const status = await new Promise<number>((resolve) =>
      request({ port, host: "127.0.0.1", path: "/login", headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      }).end(),
    );
    expect(status).toBe(host.endsWith(`:${port}`) ? 200 : 403);
  }
});

test("a POST with a foreign or missing Origin is refused", async () => {
  const { base } = await serve();
  const body = new URLSearchParams({ token: TOKEN });
  const foreign = await fetch(`${base}/login`, { method: "POST", body, headers: { origin: "http://evil.example" }, redirect: "manual" });
  expect(foreign.status).toBe(403);
  const missing = await fetch(`${base}/login`, { method: "POST", body, redirect: "manual" });
  expect(missing.status).toBe(403);
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

test("POST /login with a wrong token redirects to the generic error", async () => {
  const { base } = await serve();
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { origin: base },
    body: new URLSearchParams({ token: "wrong" }),
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/login?error=1");
  expect(res.headers.get("set-cookie")).toBeNull();
});

test("POST /login with the token sets the session cookie, which signs in", async () => {
  const { base } = await serve();
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { origin: base },
    body: new URLSearchParams({ token: TOKEN }),
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toMatch(new RegExp(`^${COOKIE}=\\d+\\.[A-Za-z0-9_-]+;`));
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain(`Max-Age=${SESSION_SECONDS}`);
  const page = await fetch(`${base}/`, { headers: { cookie: cookieOf(res)! } });
  expect(await page.text()).toBe("app GET /");
  const api = await fetch(`${base}/api/status`, { headers: { cookie: cookieOf(res)! } });
  expect(api.status).toBe(200);
  // Signed in, the sign-in page sends you on.
  const login = await fetch(`${base}/login`, { headers: { cookie: cookieOf(res)! }, redirect: "manual" });
  expect(login.status).toBe(303);
  expect(login.headers.get("location")).toBe("/");
});

test("an oversized sign-in body is refused", async () => {
  const { base } = await serve();
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { origin: base },
    body: `token=${"x".repeat(10_000)}`,
    redirect: "manual",
  }).catch(() => undefined);
  expect(res === undefined || res.status === 413).toBe(true);
});

test("?token=<right> sets the cookie and redirects without the token", async () => {
  const { base } = await serve();
  const res = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  expect(res.headers.get("set-cookie")).toContain(`${COOKIE}=`);
  const other = await fetch(`${base}/x?a=1&token=${TOKEN}&b=2`, { redirect: "manual" });
  expect(other.headers.get("location")).toBe("/x?a=1&b=2");
  const wrong = await fetch(`${base}/?token=nope`, { redirect: "manual" });
  expect(wrong.status).toBe(303);
  expect(wrong.headers.get("location")).toBe("/login?error=1");
  expect(wrong.headers.get("set-cookie")).toBeNull();
});

test("tampered and expired cookies are rejected, and a new token ends sessions", async () => {
  const { base, state } = await serve();
  const cookie = sessionCookie(TOKEN, state.now).split(";")[0]!;
  const get = async (c: string) => (await fetch(`${base}/api/status`, { headers: { cookie: c } })).status;
  expect(await get(cookie)).toBe(200);
  expect(await get(`other=1; ${cookie}`)).toBe(200);
  const [expiry, mac] = cookie.slice(COOKIE.length + 1).split(".");
  expect(await get(`${COOKIE}=${Number(expiry) + 1}.${mac}`)).toBe(401);
  expect(await get(`${COOKIE}=${expiry}.${mac!.slice(0, -2)}AA`)).toBe(401);
  expect(await get(`${COOKIE}=garbage`)).toBe(401);
  state.now += (SESSION_SECONDS + 1) * 1000;
  expect(await get(cookie)).toBe(401);
  state.now -= (SESSION_SECONDS + 1) * 1000;
  state.token = "a-new-token";
  expect(await get(cookie)).toBe(401);
  state.token = undefined;
  expect(await get(cookie)).toBe(401);
});

test("every response carries the security headers", async () => {
  const { base } = await serve();
  for (const res of [await fetch(`${base}/login`), await fetch(`${base}/api/x`), await fetch(`${base}/`, { redirect: "manual" })]) {
    expect(res.headers.get("content-security-policy")).toBe(DEFAULT_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
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

test("token and session checks", () => {
  expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
  expect(tokenMatches(TOKEN.slice(1), TOKEN)).toBe(false);
  expect(tokenMatches("", "")).toBe(false);
  expect(tokenMatches("x", undefined)).toBe(false);
  const now = Date.now();
  const cookie = sessionCookie(TOKEN, now).split(";")[0];
  expect(validSession(cookie, TOKEN, now)).toBe(true);
  expect(validSession(cookie, undefined, now)).toBe(false);
  expect(validSession(undefined, TOKEN, now)).toBe(false);
});
