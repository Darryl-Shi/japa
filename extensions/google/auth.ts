// Google sign-in: the authorization-code flow with PKCE and a loopback redirect (Google's only flow for a "Desktop
// app" client with these scopes), the stored token and its refresh, and the extension's status line.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthInteraction, AuthorizeContext } from "../../src/sdk.ts";

export const SECRETS = { clientId: "google.clientId", clientSecret: "google.clientSecret", token: "google.token" };

export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/tasks",
];

export type Endpoints = { authorize: string; token: string; userinfo: string };

export const GOOGLE: Endpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
};

/** The stored `google.token`; `expired` once Google refused its refresh token (the email stays for the status). */
export type Token = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  email: string;
  expired?: boolean;
};

export type Store = Pick<AuthorizeContext, "secret" | "setSecret">;

type Reason = "no_client" | "no_token" | "expired";

const NOT_SIGNED_IN: Record<Reason, string> = {
  no_client: "Google isn't set up: it needs google.clientId and google.clientSecret",
  no_token: "Not signed in to Google",
  expired: "The Google sign-in expired",
};

/** No usable sign-in: the tools turn `reason` into what the CoS should do about it. */
export class NotSignedIn extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {
    super(NOT_SIGNED_IN[reason]);
    this.name = "NotSignedIn";
    this.reason = reason;
  }
}

const TIMEOUT_MS = 10 * 60_000;
/** An access token this close to expiry is refreshed before use. */
const MARGIN_MS = 60_000;
const NOT_THE_ADDRESS = "That isn't the sign-in address";
const CONNECTED = "Connected to Google. You can close this tab.";

// `status` is synchronous, so it reads the last client presence and token seen.
const seen: { client: boolean; token?: Token } = { client: false };

/** The extension's status line. */
export function statusLine(): string {
  if (!seen.client || seen.token === undefined) return "not connected";
  return seen.token.expired ? "sign-in expired — ask japa to reconnect" : `connected as ${seen.token.email}`;
}

const parseToken = (raw: string | undefined): Token | undefined => {
  if (!raw) return undefined;
  try {
    const token = JSON.parse(raw) as Token;
    return typeof token?.refresh_token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
};

/** The client and token from the store, noting them for the status line. */
async function load(store: Store) {
  const [clientId, clientSecret, raw] = await Promise.all([
    store.secret(SECRETS.clientId),
    store.secret(SECRETS.clientSecret),
    store.secret(SECRETS.token),
  ]);
  const token = parseToken(raw);
  seen.client = Boolean(clientId && clientSecret);
  seen.token = token;
  return { clientId, clientSecret, token };
}

async function save(store: Store, token: Token): Promise<void> {
  await store.setSecret(SECRETS.token, JSON.stringify(token));
  seen.token = token;
}

/** Reads the client and token into the status line's cache. */
export async function primeStatus(store: Store): Promise<void> {
  // Called without awaiting at setup: a store that can't be read leaves the status "not connected".
  await load(store).catch(() => {});
}

/** Whether a sign-in is stored and Google hasn't refused it. */
export async function isConnected(store: Store): Promise<boolean> {
  const token = parseToken(await store.secret(SECRETS.token));
  seen.token = token;
  return token !== undefined && !token.expired;
}

type Reply = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  email?: string;
  error?: string;
  error_description?: string;
};

/** Node's fetch reports "fetch failed" with the reason in `cause`. */
const reason = (error: unknown) => ((error as Error).cause as Error | undefined)?.message ?? (error as Error).message;

/** How long one request to Google's sign-in endpoints may take, reply body included. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A request to Google; its JSON reply whatever the status. Network failures and a reply slower than 30 s name
 * their cause; the caller's `signal` aborting rethrows its reason.
 */
async function call(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: Reply }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  let body: Reply;
  try {
    response = await fetch(url, { ...init, signal });
    body = (await response.json().catch(() => ({}))) as Reply;
    signal.throwIfAborted(); // a body cut short by an abort is no reply
  } catch (error) {
    init.signal?.throwIfAborted();
    throw new Error(`Couldn't reach Google: ${timeout.aborted ? "no reply in 30 s" : reason(error)}`);
  }
  return { ok: response.ok, status: response.status, body };
}

const why = ({ status, body }: { status: number; body: Reply }) =>
  [body.error, body.error_description].filter(Boolean).join(": ") || `HTTP ${status}`;

const tokenRequest = (url: string, form: Record<string, string>, signal?: AbortSignal) =>
  call(url, { method: "POST", body: new URLSearchParams(form), signal });

/**
 * The code from what the user pasted: the redirect's full address, or just its code. A bare code (no `?` or `=`)
 * is taken as is; anything else must be an address with this sign-in's `state`.
 */
function pastedCode(input: string, state: string): string {
  const value = input.trim();
  if (value !== "" && !/[?=]/.test(value)) return value;
  let params: URLSearchParams;
  try {
    params = new URL(value).searchParams;
  } catch {
    throw new Error(NOT_THE_ADDRESS);
  }
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) throw new Error(NOT_THE_ADDRESS);
  if (params.get("state") !== state) throw new Error("That address is from another sign-in attempt");
  if (error) throw new Error(`Google sign-in failed: ${error}`);
  return code!;
}

const NOT_WAITING = "This isn't the sign-in japa is waiting for.";

const page = (res: ServerResponse, status: number, text: string) => {
  const escaped = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  res
    .writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" })
    .end(`<!doctype html><meta charset="utf-8"><title>japa</title><p>${escaped}</p>\n`);
};

/**
 * A listener on 127.0.0.1 for the browser's redirect, for one sign-in: `code` settles with the first request that
 * carries `state` and a code or an error; any other request gets 400 and changes nothing.
 */
async function listen(state: string) {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  code.catch(() => {}); // raced by the caller; never an unhandled rejection
  const server = createServer((req, res) => {
    // A throw here would be an uncaught exception in the daemon or setup, so nothing in this listener may throw.
    try {
      // Node's parser accepts targets such as `http://[` that the URL parser rejects: those get null here.
      const url = URL.parse(req.url ?? "/", "http://127.0.0.1");
      const params = url?.searchParams;
      const [value, error] = [params?.get("code"), params?.get("error")];
      if (url?.pathname !== "/" || params?.get("state") !== state || !(value || error)) {
        return page(res, 400, NOT_WAITING);
      }
      if (error) {
        page(res, 400, `Google sign-in failed: ${error}`);
        settle.reject(new Error(`Google sign-in failed: ${error}`));
      } else {
        page(res, 200, CONNECTED);
        settle.resolve(value!);
      }
    } catch {
      if (res.headersSent) res.destroy();
      else page(res, 400, NOT_WAITING);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    redirectUri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    code,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // a browser's open connection must not keep the flow alive
      }),
  };
}

/** Rejects with the signal's reason once it aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/**
 * Signs in to Google through `io` and stores the token: shows the consent link, then takes the code from the
 * loopback redirect or, when the browser can't reach this machine, from the address the user pastes.
 */
export async function signIn(
  store: Store,
  io: AuthInteraction,
  opts: { endpoints?: Endpoints; timeoutMs?: number } = {},
): Promise<string> {
  const endpoints = opts.endpoints ?? GOOGLE;
  const [clientId, clientSecret] = await Promise.all([
    store.secret(SECRETS.clientId),
    store.secret(SECRETS.clientSecret),
  ]);
  if (!clientId || !clientSecret) throw new Error("Google sign-in needs google.clientId and google.clientSecret");
  if (io.signal?.aborted) throw new Error("The sign-in was cancelled");

  // Everything below stops at the first of: the caller's abort, or the time limit.
  const flow = new AbortController();
  const cancel = () => flow.abort(new Error("The sign-in was cancelled"));
  io.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => flow.abort(new Error("The sign-in timed out")), opts.timeoutMs ?? TIMEOUT_MS);
  let loopback: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    loopback = await listen(state);
    const redirect_uri = loopback.redirectUri;
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri,
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    io.notify({
      type: "auth_url",
      url: `${endpoints.authorize}?${query}`,
      instructions:
        "Open the link and allow japa access to your Google account. If the page fails to load after you approve, " +
        "copy its full address and paste it here.",
    });

    // The redirect and the paste race; whichever loses is withdrawn (the listener closes below).
    const asking = new AbortController();
    let code: string;
    try {
      code = await Promise.race([
        loopback.code,
        io
          .prompt({
            type: "manual_code",
            message: "If the page didn't load after you approved, paste its full address here",
            signal: asking.signal,
          })
          .then((input) => pastedCode(input, state)),
        aborted(flow.signal),
      ]);
    } finally {
      asking.abort();
    }

    const signal = flow.signal;
    const client = { client_id: clientId, client_secret: clientSecret };
    const form = { ...client, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri };
    const issued = await tokenRequest(endpoints.token, form, signal);
    if (!issued.ok || !issued.body.access_token) throw new Error(`Google refused the sign-in: ${why(issued)}`);
    const expires_at = Date.now() + (issued.body.expires_in ?? 0) * 1000;
    if (!issued.body.refresh_token) {
      // prompt=consent should always yield one.
      throw new Error("Google didn't send a refresh token, so japa can't stay signed in; try again");
    }
    const authorization = `Bearer ${issued.body.access_token}`;
    const info = await call(endpoints.userinfo, { headers: { authorization }, signal });
    if (!info.ok || !info.body.email) throw new Error(`Couldn't read the Google account's email: ${why(info)}`);

    const token: Token = {
      access_token: issued.body.access_token,
      refresh_token: issued.body.refresh_token,
      expires_at,
      scope: issued.body.scope ?? "",
      email: info.body.email,
    };
    await save(store, token);
    seen.client = true;
    return `Connected as ${token.email}`;
  } finally {
    clearTimeout(timer);
    io.signal?.removeEventListener("abort", cancel);
    await loopback?.close();
  }
}

/** Access tokens for API calls, refreshed when close to expiry; one refresh in flight at a time. */
export function createTokens(store: Store, opts: { endpoints?: Endpoints; now?: () => number } = {}) {
  const endpoints = opts.endpoints ?? GOOGLE;
  const now = opts.now ?? Date.now;
  let refreshing: Promise<string> | undefined;

  /** The client and a live token, or why there's none. */
  const signedIn = async () => {
    const { clientId, clientSecret, token } = await load(store);
    if (!clientId || !clientSecret) throw new NotSignedIn("no_client");
    if (token === undefined) throw new NotSignedIn("no_token");
    if (token.expired) throw new NotSignedIn("expired");
    return { clientId, clientSecret, token };
  };

  const refresh = async (): Promise<string> => {
    const { clientId, clientSecret, token } = await signedIn();
    const reply = await tokenRequest(endpoints.token, {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    });
    if (reply.body.error === "invalid_grant") {
      // Revoked, or a 7-day refresh token from an app in Testing: only a new sign-in helps.
      await save(store, { ...token, expired: true });
      throw new NotSignedIn("expired");
    }
    if (!reply.ok || !reply.body.access_token) throw new Error(`Google refused to refresh the sign-in: ${why(reply)}`);
    const next: Token = {
      ...token,
      access_token: reply.body.access_token,
      expires_at: now() + (reply.body.expires_in ?? 0) * 1000,
      scope: reply.body.scope ?? token.scope,
      refresh_token: reply.body.refresh_token ?? token.refresh_token,
    };
    await save(store, next);
    return next.access_token;
  };

  /** A forced refresh, shared by every caller while it runs. */
  const shared = () =>
    (refreshing ??= refresh().finally(() => {
      refreshing = undefined;
    }));

  return {
    access: async (): Promise<string> => {
      const { token } = await signedIn();
      return token.expires_at - now() > MARGIN_MS ? token.access_token : shared();
    },
    refresh: shared,
  };
}
