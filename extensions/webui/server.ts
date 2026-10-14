// The request pipeline in front of the SvelteKit app: host and origin checks, security headers, sign-in.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { REQUEST_KEY, type WebuiRequest } from "./app/src/lib/protocol.ts";
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
      if (throttle.blocked(address, now())) {
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
        throttle.fail(address, now());
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
