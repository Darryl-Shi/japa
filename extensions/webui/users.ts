// Web UI users: `<home>/webui/users.json`, written by `japa webui users` and read by the daemon on sign-in and on
// every session check. Passwords are scrypt hashes; each user has a random session stamp that `passwd` replaces.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const NAME_MAX = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 1024;

/** The scrypt parameters new hashes use; each record keeps its own, so these can be raised later. */
export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 } as const;

export type PasswordHash = { algo: "scrypt"; N: number; r: number; p: number; salt: string; key: string };

export type WebuiUser = {
  name: string;
  /** ISO 8601. */
  createdAt: string;
  password: PasswordHash;
  /** Random; part of every session's MAC, so a new one ends the user's sessions. */
  stamp: string;
};

/** The users, or why the file can't be read (a missing file is no users). */
export type UsersResult = { ok: true; users: WebuiUser[] } | { ok: false; error: string };

export const usersDir = (home: string) => join(home, "webui");
export const usersFile = (home: string) => join(usersDir(home), "users.json");

/** `raw` lower-cased if it's a valid name, else undefined. */
export function normalName(raw: string): string | undefined {
  const name = raw.toLowerCase();
  return name.length >= 1 && name.length <= NAME_MAX && NAME_PATTERN.test(name) ? name : undefined;
}

/** Why `name` isn't a valid user name; undefined when it is. */
export function nameProblem(raw: string): string | undefined {
  if (normalName(raw) !== undefined) return undefined;
  return (
    `Invalid user name "${raw}": use 1–${NAME_MAX} characters, lower-case letters, digits, ".", "_" and "-", ` +
    "starting with a letter or digit"
  );
}

/** Why `password` isn't acceptable; undefined when it is. */
export function passwordProblem(password: string): string | undefined {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return `The password is too short: use at least ${PASSWORD_MIN} characters`;
  if (length > PASSWORD_MAX) return `The password is too long: use at most ${PASSWORD_MAX} characters`;
  return undefined;
}

function scryptAsync(password: string, salt: Buffer, p: { N: number; r: number; p: number }, keylen: number) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keylen, { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r + 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

/** A new hash of `password`, with a random 16-byte salt and the current `SCRYPT` parameters. */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT, SCRYPT.keylen);
  const { N, r, p } = SCRYPT;
  return { algo: "scrypt", N, r, p, salt: salt.toString("base64"), key: key.toString("base64") };
}

/** Whether `password` matches `hash`, compared in constant time. */
export async function verifyPassword(password: string, hash: PasswordHash): Promise<boolean> {
  const expected = Buffer.from(hash.key, "base64");
  if (expected.length === 0) return false;
  try {
    const key = await scryptAsync(password, Buffer.from(hash.salt, "base64"), hash, expected.length);
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** A fresh session stamp. */
export const newStamp = () => randomBytes(16).toString("base64url");

const isInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function validRecord(u: unknown): u is WebuiUser {
  if (typeof u !== "object" || u === null) return false;
  const r = u as Record<string, unknown>;
  const h = r.password as Record<string, unknown> | null | undefined;
  return (
    typeof r.name === "string" &&
    normalName(r.name) === r.name &&
    typeof r.createdAt === "string" &&
    typeof r.stamp === "string" &&
    r.stamp !== "" &&
    typeof h === "object" &&
    h !== null &&
    h.algo === "scrypt" &&
    isInt(h.N) &&
    isInt(h.r) &&
    isInt(h.p) &&
    typeof h.salt === "string" &&
    typeof h.key === "string"
  );
}

/** Parses the file's text. */
export function parseUsers(text: string): UsersResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the text, which holds hashes.
    return { ok: false, error: "not valid JSON" };
  }
  const users = (data as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) return { ok: false, error: 'no "users" list' };
  const bad = users.findIndex((u) => !validRecord(u));
  if (bad !== -1) return { ok: false, error: `user ${bad + 1} is malformed` };
  const names = new Set(users.map((u: WebuiUser) => u.name));
  if (names.size !== users.length) return { ok: false, error: "a user name appears twice" };
  return { ok: true, users };
}

function readProblem(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  if (e.code === "EACCES") return "permission denied";
  if (e.code === "EISDIR") return "it's a directory";
  return e.message;
}

/** Reads the users file. */
export async function readUsers(home: string): Promise<UsersResult> {
  let text: string;
  try {
    text = await readFile(usersFile(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, users: [] };
    return { ok: false, error: readProblem(error) };
  }
  return parseUsers(text);
}

/**
 * The users as the daemon sees them: the file, read again only when its mtime, size or inode changed, so the CLI's
 * changes apply on the next request.
 */
export function userStore(home: string): { load(): Promise<UsersResult>; loadSync(): UsersResult } {
  let cached: { key: string; result: UsersResult } | undefined;
  return {
    /** For the status line, which is read synchronously; small and rare. */
    loadSync() {
      let key: string;
      try {
        const s = statSync(usersFile(home));
        key = `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          cached = undefined;
          return { ok: true, users: [] };
        }
        return { ok: false, error: readProblem(error) };
      }
      if (cached?.key !== key) {
        let result: UsersResult;
        try {
          result = parseUsers(readFileSync(usersFile(home), "utf8"));
        } catch (error) {
          result = { ok: false, error: readProblem(error) };
        }
        cached = { key, result };
      }
      return cached.result;
    },
    async load() {
      let key: string;
      try {
        const s = await stat(usersFile(home));
        key = `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          cached = undefined;
          return { ok: true, users: [] };
        }
        return { ok: false, error: readProblem(error) };
      }
      if (cached?.key !== key) cached = { key, result: await readUsers(home) };
      return cached.result;
    },
  };
}

/** Writes `users` atomically (a temp file renamed over it), the dir mode 700 and the file 600. */
export function writeUsers(home: string, users: WebuiUser[]): void {
  const dir = usersDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = usersFile(home);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Whether the users file exists (for messages). */
export function usersFileExists(home: string): boolean {
  return statSync(usersFile(home), { throwIfNoEntry: false }) !== undefined;
}
