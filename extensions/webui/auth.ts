// Sign-in: the access token, and session cookies signed with it, so changing the token ends every session.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "japa_webui_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

/** A fresh access token: 32 random bytes, URL-safe. */
export const generateToken = () => randomBytes(32).toString("base64url");

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const mac = (token: string, expiry: number) =>
  createHmac("sha256", token).update(`webui-session:${expiry}`).digest("base64url");

/** Whether `given` is `token`, in constant time; never with no token set. */
export function tokenMatches(given: string, token: string | undefined): boolean {
  if (token === undefined || token === "") return false;
  return timingSafeEqual(sha256(given), sha256(token));
}

/** A `Set-Cookie` value for a new session, valid for `SESSION_SECONDS` from `now` (ms). */
export function sessionCookie(token: string, now = Date.now()): string {
  const expiry = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${COOKIE}=${expiry}.${mac(token, expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
}

/** Whether the `Cookie` header carries an unexpired session signed with `token`. */
export function validSession(cookies: string | undefined, token: string | undefined, now = Date.now()): boolean {
  if (token === undefined || token === "" || cookies === undefined) return false;
  const value = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]+)$/.exec(value ?? "");
  if (match === null) return false;
  const expiry = Number(match[1]);
  if (expiry * 1000 <= now) return false;
  const given = Buffer.from(match[2]!);
  const expected = Buffer.from(mac(token, expiry));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
