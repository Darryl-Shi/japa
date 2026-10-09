import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import {
  createTokens,
  type Endpoints,
  isConnected,
  NotSignedIn,
  primeStatus,
  signIn,
  statusLine,
  type Store,
} from "../extensions/google/auth.ts";

const SCOPE =
  "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive " +
  "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/tasks";
const CLIENT = { "google.clientId": "cid", "google.clientSecret": "csecret" };
const NOW = 1_700_000_000_000;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Reply = [status: number, body: object];

/** Google's /token (authorization_code and refresh_token grants) and /userinfo, recording what they receive. */
async function fakeGoogle(token?: (form: URLSearchParams) => Reply) {
  const forms: URLSearchParams[] = [];
  const contentTypes: string[] = [];
  const bearers: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = ([status, json]: Reply) =>
      res.writeHead(status, { "content-type": "application/json", connection: "close" }).end(JSON.stringify(json));
    if (req.method === "POST" && req.url === "/token") {
      const form = new URLSearchParams(body);
      forms.push(form);
      contentTypes.push(req.headers["content-type"] ?? "");
      send(token?.(form) ?? issue(form));
    } else if (req.url === "/userinfo") {
      bearers.push(req.headers.authorization ?? "");
      send([200, { sub: "1", email: "me@example.com", email_verified: true }]);
    } else send([404, { error: "not_found" }]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: Endpoints = { authorize: `${base}/auth`, token: `${base}/token`, userinfo: `${base}/userinfo` };
  return { endpoints, forms, contentTypes, bearers };
}

/** Google's replies: a code gets `at-<code>` and a refresh token; a refresh gets `at-refreshed` (and no new one). */
const issue = (form: URLSearchParams): Reply => {
  const common = { expires_in: 3599, scope: SCOPE, token_type: "Bearer" };
  return form.get("grant_type") === "authorization_code"
    ? [200, { ...common, access_token: `at-${form.get("code")}`, refresh_token: "rt-1", id_token: "h.p.s" }]
    : [200, { ...common, access_token: "at-refreshed" }];
};

function memoryStore(entries: Record<string, string> = {}): Store & { map: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  return { map, secret: async (name) => map.get(name), setSecret: async (name, value) => void map.set(name, value) };
}

/** An io whose `notify` captures the link and whose `manual_code` prompt waits for `paste`, failing when withdrawn. */
function fakeIo(signal?: AbortSignal) {
  const events: string[] = [];
  let notified!: (url: URL) => void;
  const link = new Promise<URL>((resolve) => (notified = resolve));
  let asked!: (q: AuthPrompt) => void;
  const prompted = new Promise<AuthPrompt>((resolve) => (asked = resolve));
  let answer!: (value: string) => void;
  const io: AuthInteraction = {
    signal,
    notify: (event) => {
      events.push(event.type);
      if (event.type === "auth_url") notified(new URL(event.url));
    },
    prompt: (q) =>
      new Promise<string>((resolve, reject) => {
        answer = resolve;
        q.signal?.addEventListener("abort", () => reject(new Error("withdrawn")), { once: true });
        asked(q);
      }),
  };
  const paste = async (value: string) => {
    await prompted;
    answer(value);
  };
  return { io, events, link, prompted, paste };
}

/** Starts a sign-in and waits for its link and prompt. */
async function start(store: Store, endpoints?: Endpoints, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const fake = fakeIo(opts.signal);
  const result = signIn(store, fake.io, { endpoints, timeoutMs: opts.timeoutMs });
  result.catch(() => {}); // asserted later
  let settled = false;
  result.then(
    () => (settled = true),
    () => (settled = true),
  );
  const url = await fake.link;
  const prompt = await fake.prompted;
  const redirectUri = url.searchParams.get("redirect_uri")!;
  return {
    ...fake,
    result,
    url,
    prompt,
    redirectUri,
    port: Number(new URL(redirectUri).port),
    state: url.searchParams.get("state")!,
    settled: () => settled,
  };
}

/** Whether nothing listens on 127.0.0.1:`port` any more. */
const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(true));
  });

/** Listening servers, after a full turn of the event loop (a closed server's handle goes in its close phase). */
const servers = async () => {
  for (let i = 0; i < 2; i++) await new Promise((resolve) => setImmediate(resolve));
  return process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;
};

const storedToken = (expires_at: number, extra: object = {}) => {
  const token = { access_token: "at-old", refresh_token: "rt-1", expires_at, scope: SCOPE, email: "me@example.com" };
  return JSON.stringify({ ...token, ...extra });
};

test("the sign-in link asks for offline access, with a state and an S256 challenge of the verifier sent to /token", async () => {
  const google = await fakeGoogle();
  const flow = await start(memoryStore(CLIENT), google.endpoints);
  const q = flow.url.searchParams;
  expect(`${flow.url.origin}${flow.url.pathname}`).toBe(google.endpoints.authorize);
  expect(q.get("client_id")).toBe("cid");
  expect(flow.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(q.get("response_type")).toBe("code");
  expect(q.get("scope")).toBe(SCOPE);
  expect(q.get("code_challenge_method")).toBe("S256");
  expect(q.get("access_type")).toBe("offline");
  expect(q.get("prompt")).toBe("consent");
  expect(flow.state).toMatch(/^[\w-]{16,}$/);
  expect(flow.prompt).toMatchObject({
    type: "manual_code",
    message: "If the page didn't load after you approved, paste its full address here",
  });

  await fetch(`${flow.redirectUri}?code=c1&state=${flow.state}`);
  await flow.result;
  expect(google.forms).toHaveLength(1);
  const form = Object.fromEntries(google.forms[0]!);
  expect(form).toEqual({
    client_id: "cid",
    client_secret: "csecret",
    code: "c1",
    code_verifier: expect.stringMatching(/^[\w-]{43,128}$/),
    grant_type: "authorization_code",
    redirect_uri: flow.redirectUri,
  });
  expect(google.contentTypes[0]).toMatch(/^application\/x-www-form-urlencoded/);
  expect(q.get("code_challenge")).toBe(createHash("sha256").update(form.code_verifier!).digest("base64url"));
});

test("the browser's redirect to the listener signs in, withdraws the prompt and stores the token", async () => {
  const google = await fakeGoogle();
  const store = memoryStore(CLIENT);
  const flow = await start(store, google.endpoints);
  const before = Date.now();
  const page = await fetch(`${flow.redirectUri}?code=c1&state=${flow.state}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Connected to Google. You can close this tab.");
  expect(await flow.result).toBe("Connected as me@example.com");
  const after = Date.now();
  expect(flow.prompt.signal?.aborted).toBe(true);
  expect(google.bearers).toEqual(["Bearer at-c1"]);
  const token = JSON.parse(store.map.get("google.token")!);
  expect(token).toMatchObject({ access_token: "at-c1", refresh_token: "rt-1", scope: SCOPE, email: "me@example.com" });
  expect(token.expired).toBeUndefined();
  expect(token.expires_at).toBeGreaterThanOrEqual(before + 3_599_000);
  expect(token.expires_at).toBeLessThanOrEqual(after + 3_599_000);
  expect(statusLine()).toBe("connected as me@example.com");
  expect(await isConnected(store)).toBe(true);
  expect(await refused(flow.port)).toBe(true);
});

test("a redirect with the wrong state gets 400 and the flow keeps waiting, then a pasted address wins", async () => {
  const google = await fakeGoogle();
  const flow = await start(memoryStore(CLIENT), google.endpoints);
  const wrong = await fetch(`${flow.redirectUri}?code=evil&state=not-it`);
  expect(wrong.status).toBe(400);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(flow.settled()).toBe(false);
  expect(flow.prompt.signal?.aborted).toBe(false);
  expect(google.forms).toEqual([]);

  await flow.paste(`${flow.redirectUri}?code=c2&state=${flow.state}`);
  expect(await flow.result).toBe("Connected as me@example.com");
  expect(google.forms.map((f) => f.get("code"))).toEqual(["c2"]);
});

/** Writes `request` to 127.0.0.1:`port` over a raw socket and resolves with everything the server answers. */
const rawRequest = (port: number, request: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(request));
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.once("end", () => resolve(answer));
    socket.once("error", reject);
  });

test("a request with a malformed target gets 400 and the flow keeps waiting, then a pasted address wins", async () => {
  const google = await fakeGoogle();
  const flow = await start(memoryStore(CLIENT), google.endpoints);
  for (const target of ["http://[", "http://a:b:c"]) {
    const answer = await rawRequest(flow.port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(answer).toMatch(/^HTTP\/1\.1 400 /);
    expect(answer).toContain("This isn't the sign-in japa is waiting for.");
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(flow.settled()).toBe(false);
  expect(flow.prompt.signal?.aborted).toBe(false);
  expect(google.forms).toEqual([]);

  await flow.paste(`${flow.redirectUri}?code=c3&state=${flow.state}`);
  expect(await flow.result).toBe("Connected as me@example.com");
  expect(google.forms.map((f) => f.get("code"))).toEqual(["c3"]);
});

test("a pasted address, with spaces around it, signs in and closes the listener", async () => {
  const google = await fakeGoogle();
  const flow = await start(memoryStore(CLIENT), google.endpoints);
  await flow.paste(`  http://127.0.0.1:1/?code=c2&state=${flow.state}  `);
  expect(await flow.result).toBe("Connected as me@example.com");
  expect(google.forms.map((f) => f.get("code"))).toEqual(["c2"]);
  expect(await refused(flow.port)).toBe(true);
});

test("a pasted bare code is used as the code", async () => {
  const google = await fakeGoogle();
  const flow = await start(memoryStore(CLIENT), google.endpoints);
  await flow.paste("  4/0Ab-c_d.e  ");
  expect(await flow.result).toBe("Connected as me@example.com");
  expect(google.forms.map((f) => f.get("code"))).toEqual(["4/0Ab-c_d.e"]);
});

test("a pasted value that is neither the address nor a bare code fails the sign-in", async () => {
  for (const pasted of ["not a url = x", "?code=c1", "https://example.com/?foo=bar", "   "]) {
    const google = await fakeGoogle();
    const flow = await start(memoryStore(CLIENT), google.endpoints);
    await flow.paste(pasted);
    await expect(flow.result, pasted).rejects.toThrow("That isn't the sign-in address");
    expect(google.forms).toEqual([]);
    expect(await refused(flow.port)).toBe(true);
  }
});

test("a pasted address from another sign-in fails without exchanging its code", async () => {
  const google = await fakeGoogle();
  const flow = await start(memoryStore(CLIENT), google.endpoints);
  await flow.paste(`${flow.redirectUri}?code=c2&state=stale`);
  await expect(flow.result).rejects.toThrow("another sign-in");
  expect(google.forms).toEqual([]);
});

test("an error in the redirect fails the sign-in with Google's reason", async () => {
  const google = await fakeGoogle();
  const store = memoryStore(CLIENT);
  const flow = await start(store, google.endpoints);
  const page = await fetch(`${flow.redirectUri}?error=access_denied&state=${flow.state}`);
  expect(await page.text()).toContain("access_denied");
  await expect(flow.result).rejects.toThrow("access_denied");
  expect(flow.prompt.signal?.aborted).toBe(true);
  expect(google.forms).toEqual([]);
  expect(store.map.has("google.token")).toBe(false);
});

test("signing in without the client id and secret fails before showing a link", async () => {
  const partial: Record<string, string>[] = [{}, { "google.clientId": "cid" }, { "google.clientSecret": "csecret" }];
  for (const entries of partial) {
    const fake = fakeIo();
    await expect(signIn(memoryStore(entries), fake.io)).rejects.toThrow("needs google.clientId and google.clientSecret");
    expect(fake.events).toEqual([]);
  }
});

test("a token response without a refresh token fails the sign-in", async () => {
  const google = await fakeGoogle(() => [200, { access_token: "at-1", expires_in: 3599, scope: SCOPE }]);
  const store = memoryStore(CLIENT);
  const flow = await start(store, google.endpoints);
  await flow.paste("c1");
  await expect(flow.result).rejects.toThrow("refresh token");
  expect(store.map.has("google.token")).toBe(false);
});

test("a failed code exchange fails the sign-in with Google's reason", async () => {
  const google = await fakeGoogle(() => [400, { error: "invalid_grant", error_description: "Bad Request" }]);
  const store = memoryStore(CLIENT);
  const flow = await start(store, google.endpoints);
  await flow.paste("c1");
  await expect(flow.result).rejects.toThrow("invalid_grant");
  expect(store.map.has("google.token")).toBe(false);
});

test("the sign-in gives up after its time limit, withdrawing the prompt and closing the listener", async () => {
  const flow = await start(memoryStore(CLIENT), undefined, { timeoutMs: 50 });
  await expect(flow.result).rejects.toThrow("timed out");
  expect(flow.prompt.signal?.aborted).toBe(true);
  expect(await refused(flow.port)).toBe(true);
});

test("aborting io.signal cancels the sign-in and leaves no listener, timer or prompt behind", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const before = await servers();
  const controller = new AbortController();
  const flow = await start(memoryStore(CLIENT), undefined, { signal: controller.signal });
  expect(await servers()).toBe(before + 1);
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  await expect(flow.result).rejects.toThrow("cancelled");
  expect(flow.prompt.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(await servers()).toBe(before);
  expect(await refused(flow.port)).toBe(true);
});

test("a sign-in whose io.signal is already aborted fails before showing a link", async () => {
  const fake = fakeIo(AbortSignal.abort());
  const before = await servers();
  await expect(signIn(memoryStore(CLIENT), fake.io)).rejects.toThrow("cancelled");
  expect(fake.events).toEqual([]);
  expect(await servers()).toBe(before);
});

test("access() returns the stored token while it has more than a minute left", async () => {
  const google = await fakeGoogle();
  const store = memoryStore({ ...CLIENT, "google.token": storedToken(NOW + 120_000) });
  const tokens = createTokens(store, { endpoints: google.endpoints, now: () => NOW });
  expect(await tokens.access()).toBe("at-old");
  expect(google.forms).toEqual([]);
  expect(statusLine()).toBe("connected as me@example.com");
});

test("concurrent access() calls near expiry share one refresh, which is stored", async () => {
  const google = await fakeGoogle();
  const store = memoryStore({ ...CLIENT, "google.token": storedToken(NOW + 30_000) });
  const tokens = createTokens(store, { endpoints: google.endpoints, now: () => NOW });
  expect(await Promise.all([tokens.access(), tokens.access(), tokens.access()])).toEqual([
    "at-refreshed",
    "at-refreshed",
    "at-refreshed",
  ]);
  expect(google.forms.map((f) => Object.fromEntries(f))).toEqual([
    { client_id: "cid", client_secret: "csecret", grant_type: "refresh_token", refresh_token: "rt-1" },
  ]);
  expect(JSON.parse(store.map.get("google.token")!)).toEqual({
    access_token: "at-refreshed",
    refresh_token: "rt-1",
    expires_at: NOW + 3_599_000,
    scope: SCOPE,
    email: "me@example.com",
  });
  expect(await tokens.access()).toBe("at-refreshed");
  expect(google.forms).toHaveLength(1);
});

test("refresh() refreshes even a fresh token", async () => {
  const google = await fakeGoogle();
  const store = memoryStore({ ...CLIENT, "google.token": storedToken(NOW + 3_000_000) });
  const tokens = createTokens(store, { endpoints: google.endpoints, now: () => NOW });
  expect(await tokens.refresh()).toBe("at-refreshed");
  expect(google.forms.map((f) => f.get("grant_type"))).toEqual(["refresh_token"]);
});

test("a refresh answered invalid_grant marks the sign-in expired", async () => {
  const revoked = { error: "invalid_grant", error_description: "Token has been expired or revoked." };
  const google = await fakeGoogle(() => [400, revoked]);
  const store = memoryStore({ ...CLIENT, "google.token": storedToken(NOW + 30_000) });
  const tokens = createTokens(store, { endpoints: google.endpoints, now: () => NOW });
  const error = await tokens.access().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NotSignedIn);
  expect((error as NotSignedIn).reason).toBe("expired");
  expect(JSON.parse(store.map.get("google.token")!)).toMatchObject({ expired: true, email: "me@example.com" });
  expect(statusLine()).toBe("sign-in expired — ask japa to reconnect");
  expect(await isConnected(store)).toBe(false);
  // Expired stays expired, without asking Google again.
  expect(((await tokens.access().catch((e: unknown) => e)) as NotSignedIn).reason).toBe("expired");
  expect(google.forms).toHaveLength(1);
});

test("any other refresh failure is an error with Google's reason, and keeps the sign-in", async () => {
  const google = await fakeGoogle(() => [500, { error: "backend_error", error_description: "Try later" }]);
  const store = memoryStore({ ...CLIENT, "google.token": storedToken(NOW + 30_000) });
  const tokens = createTokens(store, { endpoints: google.endpoints, now: () => NOW });
  const error = await tokens.access().catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(NotSignedIn);
  expect((error as Error).message).toContain("Try later");
  expect(JSON.parse(store.map.get("google.token")!).expired).toBeUndefined();
  expect(await isConnected(store)).toBe(true);
});

test("a refresh Google doesn't answer gives up after 30 s, and keeps the sign-in", async () => {
  const hung = createServer(() => {}); // reads the request, never replies
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        hung.close(() => resolve());
        hung.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`;
  const timeouts: number[] = [];
  const timeout = new AbortController();
  const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    timeouts.push(ms);
    return timeout.signal;
  });
  try {
    const store = memoryStore({ ...CLIENT, "google.token": storedToken(NOW + 3_000_000) });
    const endpoints = { authorize: `${base}/auth`, token: `${base}/token`, userinfo: `${base}/userinfo` };
    const tokens = createTokens(store, { endpoints, now: () => NOW });
    const pending = tokens.refresh().catch((e: unknown) => e);
    await vi.waitFor(() => expect(timeouts).toEqual([30_000]));
    timeout.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const error = (await pending) as Error;
    expect(error).not.toBeInstanceOf(NotSignedIn);
    expect(error.message).toBe("Couldn't reach Google: no reply in 30 s");
    expect(JSON.parse(store.map.get("google.token")!).expired).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("the sign-in's code exchange and account lookup each have a 30 s limit", async () => {
  const google = await fakeGoogle();
  const spy = vi.spyOn(AbortSignal, "timeout");
  try {
    const flow = await start(memoryStore(CLIENT), google.endpoints);
    await flow.paste(`http://127.0.0.1:1/?code=c3&state=${flow.state}`);
    expect(await flow.result).toBe("Connected as me@example.com");
    expect(spy.mock.calls.map((call) => call[0])).toEqual([30_000, 30_000]);
  } finally {
    spy.mockRestore();
  }
});

test("access() without a token or without the client is not signed in", async () => {
  const google = await fakeGoogle();
  const reason = (store: Store) =>
    createTokens(store, { endpoints: google.endpoints, now: () => NOW })
      .access()
      .catch((e: unknown) => (e instanceof NotSignedIn ? e.reason : e));
  expect(await reason(memoryStore(CLIENT))).toBe("no_token");
  expect(statusLine()).toBe("not connected");
  expect(await reason(memoryStore({ "google.token": storedToken(NOW + 120_000) }))).toBe("no_client");
  expect(statusLine()).toBe("not connected");
  expect(google.forms).toEqual([]);
});

test("primeStatus reads the client and token into the status line", async () => {
  await primeStatus(memoryStore({ ...CLIENT, "google.token": storedToken(NOW) }));
  expect(statusLine()).toBe("connected as me@example.com");
  await primeStatus(memoryStore(CLIENT));
  expect(statusLine()).toBe("not connected");
  await primeStatus(memoryStore({ ...CLIENT, "google.token": storedToken(NOW, { expired: true }) }));
  expect(statusLine()).toBe("sign-in expired — ask japa to reconnect");
  await primeStatus(memoryStore({ "google.token": storedToken(NOW) }));
  expect(statusLine()).toBe("not connected");
});

test("isConnected follows the stored token", async () => {
  expect(await isConnected(memoryStore(CLIENT))).toBe(false);
  expect(await isConnected(memoryStore({ ...CLIENT, "google.token": storedToken(NOW) }))).toBe(true);
  const expired = memoryStore({ ...CLIENT, "google.token": storedToken(NOW, { expired: true }) });
  expect(await isConnected(expired)).toBe(false);
});
