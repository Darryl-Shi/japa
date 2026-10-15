// The request pipeline in front of the SvelteKit app: host and origin checks, security headers, sign-in.
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { API, DESKTOP_VIEW_KEY, type DesktopViewHandle, REQUEST_KEY, type WebuiRequest } from "./app/src/lib/protocol.ts";
import { clearedCookie, dummyHash, sessionCookie, sessionUser, Throttle } from "./auth.ts";
import { type UsersResult, verifyPassword } from "./users.ts";

/** adapter-node's `handler`. */
export type Handler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;

export type PipelineDeps = {
  /** The address the server listens on. */
  bind: string;
  /** Extra DNS names accepted as the Host (setting `hosts`), on any port. */
  hosts?: readonly string[];
  /** The web UI users, read per request (the store caches by mtime). */
  users(): Promise<UsersResult>;
  /** The session key, read per request. */
  sessionKey(): Promise<string | undefined>;
  handler: Handler;
  now?(): number;
};

const LOGIN_BODY_LIMIT = 4096;
const PUBLIC = ["/favicon.svg", "/robots.txt"];

/** The default CSP; SvelteKit's pages replace it with their own, which hashes their inline script. */
export const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** `host:port` as a URL or `Host` header writes it (IPv6 in brackets). */
export const hostPort = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${port}`;

/** The name in a `Host` header (`name`, `name:port`, `[v6]`, `[v6]:port`), lower-cased; undefined if malformed. */
function hostName(host: string): string | undefined {
  const bracketed = /^\[([^\]]*)\](?::\d{1,5})?$/.exec(host);
  if (bracketed) return isIP(bracketed[1]!) === 6 ? bracketed[1]!.toLowerCase() : undefined;
  return /^([^:[\]]+)(?::\d{1,5})?$/.exec(host)?.[1]!.toLowerCase();
}

/**
 * Whether `host` (a `Host` header) names this server. DNS rebinding always arrives with the attacker's domain
 * name in Host, never a bare IP, so any IP literal is safe to accept -- the address of a published port, a VPN
 * address. Names must be ours: localhost, the bind address, the `hosts` setting. Any port: a tunnel or a
 * published port needn't match the one we listen on.
 */
export function acceptedHost(host: string, bind: string, extra: readonly string[] = []): boolean {
  const name = hostName(host);
  if (name === undefined) return false;
  if (isIP(name) !== 0) return true;
  const names = ["localhost", "127.0.0.1", bind, ...extra].map((n) => n.toLowerCase());
  return names.includes(name);
}

/** The request listener. */
export function pipeline(deps: PipelineDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const now = deps.now ?? Date.now;
  const throttle = new Throttle();
  // Made now, so the first unknown-name sign-in costs one scrypt like any other.
  void dummyHash();
  return (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Internal error");
      else res.destroy();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    defaultCsp(res);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Not no-referrer: under it browsers send `Origin: null` on the sign-in form's POST.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");

    // DNS rebinding: only our own names (or IP literals) for this server.
    const host = req.headers.host?.toLowerCase();
    if (host === undefined || !acceptedHost(host, deps.bind, deps.hosts)) return send(res, 403, "Refused");
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD" && req.headers.origin?.toLowerCase() !== `http://${host}`) {
      return send(res, 403, "Refused");
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/^\/{2,}/, "/");
    const key = await deps.sessionKey();
    const users = await deps.users();
    const list = users.ok ? users.users : [];

    if (path === "/login" && method === "POST") {
      const address = req.socket.remoteAddress ?? "";
      // Reserved before the (slow) check, so parallel guesses can't get past the limit.
      if (!throttle.reserve(address, now())) {
        res.setHeader("Retry-After", "60");
        return send(res, 429, "Too many failed sign-ins: try again in a minute");
      }
      const body = await readBody(req, LOGIN_BODY_LIMIT);
      if (body === undefined) return send(res, 413, "Too large");
      const form = new URLSearchParams(body);
      const name = (form.get("username") ?? "").trim().toLowerCase();
      const password = form.get("password") ?? "";
      const user = list.find((u) => u.name === name);
      // An unknown name is checked against a dummy hash, so the time taken doesn't tell which names exist.
      const matches = await verifyPassword(password, user?.password ?? (await dummyHash()));
      if (!matches || user === undefined || key === undefined || key === "") {
        return redirect(res, "/login?error=1");
      }
      throttle.clear(address);
      res.setHeader("Set-Cookie", sessionCookie(key, user, now()));
      return redirect(res, "/");
    }

    const signedIn = sessionUser(req.headers.cookie, key, list, now());
    const info: WebuiRequest = {
      ...(signedIn !== undefined && { user: signedIn }),
      users: !users.ok ? "unreadable" : list.length === 0 ? "none" : "some",
    };
    (req as unknown as Record<symbol, WebuiRequest>)[Symbol.for(REQUEST_KEY)] = info;
    if (path === "/login" && (method === "GET" || method === "HEAD")) {
      return signedIn !== undefined ? redirect(res, "/") : deps.handler(req, res, () => send(res, 404, "Not found"));
    }
    const isPublic = path.startsWith("/_app/") || PUBLIC.includes(path);
    if (signedIn === undefined && !isPublic) {
      if (path === "/api" || path.startsWith("/api/")) return json(res, 401, { error: "Not signed in" });
      return method === "GET" || method === "HEAD" ? redirect(res, "/login") : send(res, 401, "Not signed in");
    }
    if (path === "/logout" && method === "POST") {
      // Sessions are stateless: this clears this browser's cookie only.
      res.setHeader("Set-Cookie", clearedCookie());
      return redirect(res, "/login");
    }
    deps.handler(req, res, () => send(res, 404, "Not found"));
  }
}

/**
 * Gives every response that sets no CSP of its own the default one, as its headers are written -- except a 304,
 * whose headers the browser merges into the cached page: SvelteKit's 304s carry no CSP, and the default would
 * replace the page's hashed one.
 */
function defaultCsp(res: ServerResponse) {
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    const headers = rest.find((r) => typeof r === "object" && r !== null);
    const names = Array.isArray(headers)
      ? headers.filter((_, i) => i % 2 === 0).map(String)
      : Object.keys((headers ?? {}) as object);
    const own = res.hasHeader("Content-Security-Policy") || names.some((n) => n.toLowerCase() === "content-security-policy");
    if (status !== 304 && !own) res.setHeader("Content-Security-Policy", DEFAULT_CSP);
    return writeHead(status, ...rest);
  }) as typeof res.writeHead;
}

function send(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(text);
}

function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { Location: location }).end();
}

/** The request body as text; undefined when it's over `limit` bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The desktop extension's view handle, read per use: undefined while the desktop isn't loaded or is turned off. */
export function desktopHandle(): DesktopViewHandle | undefined {
  const handle = (globalThis as Record<symbol, DesktopViewHandle | undefined>)[Symbol.for(DESKTOP_VIEW_KEY)];
  // Turned off, it stays loaded (only hidden from the CoS): the panel, Start and the websocket treat it as absent.
  return handle !== undefined && handle.enabled() ? handle : undefined;
}

export type ProxyDeps = Omit<PipelineDeps, "handler"> & {
  desktop?(): DesktopViewHandle | undefined;
  /** How often open connections' sessions are rechecked (default 30 s). */
  recheckMs?: number;
};

/** Request headers not passed on to websockify: the session cookie and browser context stay here. */
const DROPPED = new Set(["host", "cookie", "origin", "referer", "authorization"]);

/**
 * The server's `upgrade` listener: the Desktop panel's websocket (`/api/desktop/ws`), proxied byte for byte to the
 * desktop's websockify once the Host, the Origin (the same origin: cross-site websocket hijacking) and the session
 * cookie check out. `close()` ends every proxied connection (the surface stopping).
 */
export function desktopProxy(deps: ProxyDeps): {
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
  /** How many proxied connections are open (tests). */
  readonly open: number;
} {
  const now = deps.now ?? Date.now;
  const desktop = deps.desktop ?? desktopHandle;
  /** Each proxied connection's teardown. */
  const connections = new Set<() => void>();
  /**
   * Each open connection's session cookie: rechecked, so an expiry, a new password or a removed user (or a new
   * session key) ends it.
   */
  const sessions = new Map<() => void, string | undefined>();
  const recheck = setInterval(async () => {
    if (sessions.size === 0) return;
    for (const [teardown, cookie] of sessions) if ((await signedIn(cookie)) === undefined) teardown();
  }, deps.recheckMs ?? 30_000);
  recheck.unref();
  let closed = false;

  /** The user `cookies` carries a valid session of, read against the current users and session key. */
  async function signedIn(cookies: string | undefined): Promise<string | undefined> {
    try {
      const [key, users] = await Promise.all([deps.sessionKey(), deps.users()]);
      return sessionUser(cookies, key, users.ok ? users.users : [], now());
    } catch {
      return undefined;
    }
  }

  function refuse(socket: Duplex, status: string) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    setTimeout(() => socket.destroy(), 1000).unref();
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/{2,}/, "/");
    const host = req.headers.host?.toLowerCase();
    if (host === undefined || !acceptedHost(host, deps.bind, deps.hosts)) return refuse(socket, "403 Forbidden");
    if (path !== API.desktopWs) return refuse(socket, "404 Not Found");
    if (req.headers.origin?.toLowerCase() !== `http://${host}`) return refuse(socket, "403 Forbidden");
    if ((await signedIn(req.headers.cookie)) === undefined) return refuse(socket, "401 Unauthorized");
    if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket") return refuse(socket, "400 Bad Request");
    const handle = desktop();
    if (handle === undefined) return refuse(socket, "503 Service Unavailable");
    if (closed || socket.destroyed) return socket.destroy();

    const target = handle.target();
    const lines = [`GET /websockify HTTP/1.1`, `Host: ${hostPort(target.host, target.port)}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!DROPPED.has(req.rawHeaders[i]!.toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    const upstream: Socket = connect(target.port, target.host);
    let connected = false;
    const teardown = () => {
      connections.delete(teardown);
      sessions.delete(teardown);
      socket.destroy();
      upstream.destroy();
    };
    connections.add(teardown);
    sessions.set(teardown, req.headers.cookie);
    upstream.on("error", () => {
      if (connected || socket.destroyed) return teardown();
      connections.delete(teardown);
      refuse(socket, "502 Bad Gateway");
    });
    upstream.once("connect", () => {
      connected = true;
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on("close", teardown);
    upstream.on("close", () => {
      if (connected) teardown();
    });
  }

  return {
    upgrade(req, socket, head) {
      upgrade(req, socket, head).catch(() => socket.destroy());
    },
    close() {
      closed = true;
      clearInterval(recheck);
      for (const teardown of [...connections]) teardown();
    },
    get open() {
      return connections.size;
    },
  };
}
