import { createServer, request, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
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
async function serve(handler: Handler = (req, res) => res.end(`app ${req.method} ${req.url}`), hosts?: string[]) {
  const state = { token: TOKEN as string | undefined, now: Date.now() };
  server = createServer(pipeline({ bind: "127.0.0.1", hosts, token: async () => state.token, handler, now: () => state.now }));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, state };
}

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
  const body = new URLSearchParams({ token: TOKEN }).toString();
  const post = (origin: string) =>
    statusFor(port, "japa.example.corp:7337", { method: "POST", origin, body });
  expect(await post("http://japa.example.corp:7337")).toBe(303);
  expect(await post("http://japa.example.corp:7338")).toBe(403);
  expect(await post("http://evil.example")).toBe(403);
});

test("a POST from an IP-literal host needs the matching Origin", async () => {
  const { port } = await serve();
  const body = new URLSearchParams({ token: TOKEN }).toString();
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
  const api = await fetch(`${base}/api/update`, { headers: { cookie: cookieOf(res)! } });
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
  const get = async (c: string) => (await fetch(`${base}/api/update`, { headers: { cookie: c } })).status;
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
