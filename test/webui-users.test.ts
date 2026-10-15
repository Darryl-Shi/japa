// `japa webui users`, driven as a user runs it: the real CLI, against a scratch JAPA_HOME.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { verifyPassword, type WebuiUser } from "../extensions/webui/users.ts";
import { ensureClone } from "../src/kernel/jobs/clone.ts";
import { git } from "../src/kernel/workspace.ts";

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Runs `japa webui <args>` with `JAPA_HOME=home`, `input` on stdin (not a terminal). */
function japa(home: string, args: string[], input = "") {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, "webui", ...args], {
    env: { ...process.env, JAPA_HOME: home },
    input,
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const scratch = () => mkdtempSync(join(tmpdir(), "japa-webui-users-"));
const usersOf = (home: string) =>
  (JSON.parse(readFileSync(join(home, "webui", "users.json"), "utf8")) as { users: WebuiUser[] }).users;

test("add, list, passwd and remove, with --password-stdin", async () => {
  const home = scratch();
  expect(japa(home, ["users", "list"])).toMatchObject({ code: 0, stdout: expect.stringContaining("no web UI users") });
  expect(japa(home, ["users", "list"]).stdout).toContain("japa webui users add <name>");

  const added = japa(home, ["users", "add", "Alice", "--password-stdin"], "secret123\n");
  expect(added).toMatchObject({ code: 0 });
  expect(added.stdout).toContain('"alice"');
  const [alice] = usersOf(home);
  expect(alice).toMatchObject({ name: "alice", password: { algo: "scrypt", r: 8, p: 1 } });
  expect(alice!.password.N).toBeGreaterThanOrEqual(2 ** 15);
  expect(Buffer.from(alice!.password.salt, "base64")).toHaveLength(16);
  expect(Number.isNaN(Date.parse(alice!.createdAt))).toBe(false);
  expect(await verifyPassword("secret123", alice!.password)).toBe(true);
  expect(readFileSync(join(home, "webui", "users.json"), "utf8")).not.toContain("secret123");

  // Only the first line is the password.
  expect(japa(home, ["users", "add", "bob", "--password-stdin"], "bob-password\nignored\n").code).toBe(0);
  const list = japa(home, ["users", "list"]);
  expect(list.code).toBe(0);
  const lines = list.stdout.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^alice\s+created \d{4}-/);
  expect(lines[1]).toMatch(/^bob\s+created /);
  expect(list.stdout).not.toContain(alice!.password.key);
  expect(list.stdout).not.toContain(alice!.stamp);

  const passwd = japa(home, ["users", "passwd", "ALICE", "--password-stdin"], "another-secret\n");
  expect(passwd.code).toBe(0);
  const changed = usersOf(home).find((u) => u.name === "alice")!;
  expect(changed.stamp).not.toBe(alice!.stamp);
  expect(changed.createdAt).toBe(alice!.createdAt);
  expect(await verifyPassword("another-secret", changed.password)).toBe(true);
  expect(await verifyPassword("secret123", changed.password)).toBe(false);
  const bobBefore = usersOf(home).find((u) => u.name === "bob")!;

  expect(japa(home, ["users", "remove", "alice"]).code).toBe(0);
  expect(usersOf(home)).toEqual([bobBefore]);
});

test("duplicates, unknown names, invalid names and passwords exit 1 with a message", () => {
  const home = scratch();
  expect(japa(home, ["users", "add", "carol", "--password-stdin"], "secret123\n").code).toBe(0);
  const before = readFileSync(join(home, "webui", "users.json"), "utf8");
  const cases: [string[], string, RegExp][] = [
    [["users", "add", "carol", "--password-stdin"], "other-password\n", /already a web UI user "carol"/],
    [["users", "add", "CAROL", "--password-stdin"], "other-password\n", /already/],
    [["users", "passwd", "dave", "--password-stdin"], "secret123\n", /no web UI user "dave"/],
    [["users", "remove", "dave"], "", /no web UI user "dave"/],
    [["users", "add", "-bad", "--password-stdin"], "secret123\n", /Invalid user name/],
    [["users", "add", "has space", "--password-stdin"], "secret123\n", /Invalid user name/],
    [["users", "add", "a".repeat(33), "--password-stdin"], "secret123\n", /Invalid user name/],
    [["users", "add", "dave", "--password-stdin"], "short\n", /too short/],
    [["users", "add", "dave", "--password-stdin"], `${"x".repeat(1025)}\n`, /too long/],
    [["users", "passwd", "carol", "--password-stdin"], "\n", /too short/],
    [["users", "add"], "", /Usage/],
    [["users", "frobnicate"], "", /Unknown command/],
    [["users", "add", "dave", "--force"], "", /Unknown option --force/],
    [["nope"], "", /Usage: japa webui users/],
  ];
  for (const [args, input, message] of cases) {
    const result = japa(home, args, input);
    expect(result.code, args.join(" ")).toBe(1);
    expect(result.stderr, args.join(" ")).toMatch(message);
  }
  expect(readFileSync(join(home, "webui", "users.json"), "utf8")).toBe(before);
  // The longest valid ones are fine.
  expect(japa(home, ["users", "add", `a${"b".repeat(31)}`, "--password-stdin"], `${"x".repeat(1024)}\n`).code).toBe(0);
  expect(japa(home, ["users", "add", "e.f_g-9", "--password-stdin"], "12345678\n").code).toBe(0);
});

test("without a terminal and without --password-stdin, add and passwd fail with a clear message", () => {
  const home = scratch();
  const add = japa(home, ["users", "add", "carol"], "secret123\n");
  expect(add.code).toBe(1);
  expect(add.stderr).toMatch(/needs a terminal.*--password-stdin/s);
  expect(japa(home, ["users", "add", "carol", "--password-stdin"], "secret123\n").code).toBe(0);
  const passwd = japa(home, ["users", "passwd", "carol"], "secret456\n");
  expect(passwd.code).toBe(1);
  expect(passwd.stderr).toMatch(/needs a terminal/);
});

test("the file is mode 600 in a mode 700 dir, ignored by git, and not in a job's clone", () => {
  const home = scratch();
  expect(japa(home, ["users", "add", "carol", "--password-stdin"], "secret123\n").code).toBe(0);
  expect(statSync(join(home, "webui")).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, "webui", "users.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(home, ".gitignore"), "utf8").split("\n")).toContain("/webui/");
  expect(git(home, "check-ignore", "webui/users.json")).toBe("webui/users.json");
  expect(git(home, "status", "--porcelain", "--ignored=no")).toBe("");
  // After a change, still 600, and no temp file left.
  expect(japa(home, ["users", "passwd", "carol", "--password-stdin"], "secret456\n").code).toBe(0);
  expect(statSync(join(home, "webui", "users.json")).mode & 0o777).toBe(0o600);
  expect(spawnSync("ls", ["-A", join(home, "webui")], { encoding: "utf8" }).stdout).toBe("users.json\n");
  const clone = ensureClone(home, PACKAGE_ROOT, "1");
  expect(statSync(join(clone, "webui"), { throwIfNoEntry: false })).toBeUndefined();
});

test("a file it can't parse is reported and left as it is", () => {
  const home = scratch();
  mkdirSync(join(home, "webui"));
  writeFileSync(join(home, "webui", "users.json"), "{ not json");
  for (const [args, input] of [
    [["users", "add", "carol", "--password-stdin"], "secret123\n"],
    [["users", "remove", "carol"], ""],
    [["users", "list"], ""],
  ] as const) {
    const result = japa(home, [...args], input);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("users.json: not valid JSON");
  }
  expect(readFileSync(join(home, "webui", "users.json"), "utf8")).toBe("{ not json");
});

test("japa's usage lists webui users", () => {
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], { encoding: "utf8" });
  expect(result.stderr).toContain("webui users <add|passwd|remove|list>");
});
