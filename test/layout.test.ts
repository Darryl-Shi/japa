import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { APP, layoutOf, launcherPointsAt, launcherText, shellQuote, writeLauncher } from "../src/cli/layout.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "japa-layout-"));

test("launcher quotes paths with spaces and quotes", () => {
  expect(launcherText("/a b/node", "/x/it's/app")).toBe(
    "#!/bin/sh\nexec '/a b/node' --disable-warning=ExperimentalWarning '/x/it'\\''s/app/src/cli/main.ts' \"$@\"\n",
  );
});

test("layoutOf: managed only for <dir>/app", () => {
  expect(layoutOf("/h/.local/share/japa/app", "/h")).toEqual({
    app: "/h/.local/share/japa/app",
    installDir: "/h/.local/share/japa",
    nodeDir: "/h/.local/share/japa/node",
    launcher: "/h/.local/bin/japa",
  });
  expect(layoutOf("/h/projects/japa", "/h").installDir).toBeUndefined();
  expect(layoutOf("/h/projects/japa", "/h").nodeDir).toBeUndefined();
});

test("shellQuote wraps in single quotes and escapes an embedded quote", () => {
  expect(shellQuote("plain")).toBe("'plain'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
});

test("writeLauncher writes an executable launcher that launcherPointsAt recognizes", () => {
  const home = tmp();
  const layout = layoutOf(join(home, "install", "app"), home);

  writeLauncher(layout, "/opt/node/bin/node");

  expect(readFileSync(layout.launcher, "utf8")).toBe(launcherText("/opt/node/bin/node", layout.app));
  expect(statSync(layout.launcher).mode & 0o777).toBe(0o755);
  expect(launcherPointsAt(layout)).toBe(true);
});

test("launcherPointsAt is false for another checkout's launcher", () => {
  const home = tmp();
  const layout = layoutOf(join(home, "install", "app"), home);
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(layout.launcher, launcherText("/opt/node/bin/node", "/other"));

  expect(launcherPointsAt(layout)).toBe(false);
});

test("launcherPointsAt is false when there is no launcher yet", () => {
  const home = tmp();
  expect(launcherPointsAt(layoutOf(join(home, "install", "app"), home))).toBe(false);
});

test("APP is this checkout's root: the directory holding package.json", () => {
  expect((JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { name: string }).name).toBe("japa");
});

test("japa --version prints the version and sha", () => {
  expect(execFileSync(process.execPath, ["src/cli/main.ts", "--version"], { encoding: "utf8" })).toMatch(
    /^japa 0\.1\.0 \([0-9a-f]{7,}\)\n$/,
  );
});

test("japa's usage lists --version", () => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli/main.ts"], { encoding: "utf8" });

  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/^ {2}--version +Print the version and git commit$/m);
});
