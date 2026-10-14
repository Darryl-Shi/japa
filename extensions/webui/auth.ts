// Sessions and sign-in throttling. A session cookie is `<name>.<expiry>.<mac>`, the MAC keyed with the session key
// over the user's current session stamp: removing the user, a new password (a new stamp) or a new key ends it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hashPassword, type PasswordHash, type WebuiUser } from "./users.ts";

export const COOKIE = "japa_webui_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

/** A fresh session key: 32 random bytes, URL-safe. */
export const generateSessionKey = () => randomBytes(32).toString("base64url");

const mac = (key: string, name: string, expiry: number, stamp: string) =>
  createHmac("sha256", key).update(`webui-session:${name}:${expiry}:${stamp}`).digest("base64url");

/** A `Set-Cookie` value for a new session of `user`, valid for `SESSION_SECONDS` from `now` (ms). */
export function sessionCookie(key: string, user: Pick<WebuiUser, "name" | "stamp">, now = Date.now()): string {
  const expiry = Math.floor(now / 1000) + SESSION_SECONDS;
  const value = `${user.name}.${expiry}.${mac(key, user.name, expiry, user.stamp)}`;
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
}

/** A `Set-Cookie` value that clears the session cookie. */
export const clearedCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/**
 * The name of the user whose unexpired session, signed with `key` over their current stamp, the `Cookie` header
 * carries; undefined if none.
 */
export function sessionUser(
  cookies: string | undefined,
  key: string | undefined,
  users: readonly Pick<WebuiUser, "name" | "stamp">[],
  now = Date.now(),
): string | undefined {
  if (key === undefined || key === "" || cookies === undefined) return undefined;
  const value = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  // Names are `[a-z0-9][a-z0-9._-]*`, so the last two dots split it.
  const match = /^([a-z0-9][a-z0-9._-]{0,31})\.(\d{1,12})\.([A-Za-z0-9_-]+)$/.exec(value ?? "");
  if (match === null) return undefined;
  const [, name, expiryText, given] = match as unknown as [string, string, string, string];
  const expiry = Number(expiryText);
  if (expiry * 1000 <= now) return undefined;
  const user = users.find((u) => u.name === name);
  if (user === undefined) return undefined;
  const a = Buffer.from(given);
  const b = Buffer.from(mac(key, name, expiry, user.stamp));
  return a.length === b.length && timingSafeEqual(a, b) ? name : undefined;
}

let dummy: Promise<PasswordHash> | undefined;
/** A hash no password is checked against for real: an unknown name costs the same scrypt as a known one. */
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString("base64")));

export const THROTTLE_FAILURES = 10;
export const THROTTLE_WINDOW_MS = 60_000;

/** Failed sign-ins per client address, in memory: at most `THROTTLE_FAILURES` per rolling `THROTTLE_WINDOW_MS`. */
export class Throttle {
  private failures = new Map<string, number[]>();

  private recent(address: string, now: number): number[] {
    const kept = (this.failures.get(address) ?? []).filter((t) => now - t < THROTTLE_WINDOW_MS);
    if (kept.length === 0) this.failures.delete(address);
    else this.failures.set(address, kept);
    return kept;
  }

  /** Whether `address` has used up its failures. */
  blocked(address: string, now: number): boolean {
    return this.recent(address, now).length >= THROTTLE_FAILURES;
  }

  fail(address: string, now: number): void {
    // Now and then, forget addresses whose window has passed.
    if (this.failures.size > 1000) for (const a of [...this.failures.keys()]) this.recent(a, now);
    this.failures.set(address, [...this.recent(address, now), now]);
  }

  clear(address: string): void {
    this.failures.delete(address);
  }
}
