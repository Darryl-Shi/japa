import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Exec, ExecResult } from "../src/cli/exec.ts";
import { layoutOf, launcherText, writeLauncher } from "../src/cli/layout.ts";
import { NODE_MARKER } from "../src/cli/node.ts";
import type { ServiceEnv } from "../src/cli/service.ts";
import { uninstall } from "../src/cli/uninstall.ts";
import { tempHome } from "./helpers.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "japa-uninstall-"));

/** A fake `Exec` that records every call and always succeeds. */
function fakeExec(): { exec: Exec; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: "", stderr: "" } satisfies ExecResult;
  };
  return { exec, calls };
}

function fakeServiceEnv(overrides: Partial<ServiceEnv> = {}): ServiceEnv {
  return {
    platform: "linux",
    userHome: tmp(),
    configHome: tmp(),
    launcher: "/unused",
    japaHome: tmp(),
    customHome: false,
    path: "",
    user: "alice",
    uid: 1000,
    exec: fakeExec().exec,
    ...overrides,
  };
}

test("uninstall removes a managed install and keeps home", async () => {
  const root = tmp();
  const home = tempHome();
  const layout = layoutOf(join(root, "install", "app"), root);
  mkdirSync(layout.app, { recursive: true });
  writeLauncher(layout, "/opt/node/bin/node");
  const { exec, calls } = fakeExec();
  const logs: string[] = [];
  const confirm = vi.fn(async () => "delete");

  await uninstall(layout, home, { purge: false, confirm, serviceEnv: fakeServiceEnv({ exec }), log: (s) => logs.push(s) });

  expect(existsSync(layout.launcher)).toBe(false);
  expect(existsSync(layout.installDir!)).toBe(false);
  expect(existsSync(home)).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  expect(logs).toContain(`kept ${home}`);
  // uninstallService actually ran (not skipped).
  expect(calls.some((c) => c.cmd === "systemctl" && c.args.includes("disable"))).toBe(true);
});

test('--purge without "delete" removes nothing at all', async () => {
  const root = tmp();
  const home = tempHome();
  const layout = layoutOf(join(root, "install", "app"), root);
  mkdirSync(layout.app, { recursive: true });
  writeLauncher(layout, "/opt/node/bin/node");
  const { exec, calls } = fakeExec();
  const logs: string[] = [];

  await uninstall(layout, home, { purge: true, confirm: async () => "nope", serviceEnv: fakeServiceEnv({ exec }), log: (s) => logs.push(s) });

  // Confirmation happens before anything is touched: an answer other than "delete" leaves everything in place,
  // including the service, the launcher and the install dir (not just `home`).
  expect(existsSync(home)).toBe(true);
  expect(existsSync(layout.launcher)).toBe(true);
  expect(existsSync(layout.installDir!)).toBe(true);
  expect(calls).toEqual([]);
  expect(logs).toContain("purge cancelled; nothing was removed");
});

test('--purge with "delete" removes home', async () => {
  const root = tmp();
  const home = tempHome();
  const layout = layoutOf(join(root, "install", "app"), root);
  mkdirSync(layout.app, { recursive: true });
  const logs: string[] = [];

  await uninstall(layout, home, { purge: true, confirm: async () => "delete", serviceEnv: fakeServiceEnv(), log: (s) => logs.push(s) });

  expect(existsSync(home)).toBe(false);
  expect(logs).toContain(`removed ${home}`);
  expect(logs).not.toContain(`kept ${home}`);
});

test("a dev checkout is left in place", async () => {
  const root = tmp();
  const home = tempHome();
  const layout = layoutOf(join(root, "projects", "japa"), root); // basename !== "app" -> unmanaged
  mkdirSync(layout.app, { recursive: true });
  const logs: string[] = [];

  await uninstall(layout, home, { purge: false, confirm: async () => "delete", serviceEnv: fakeServiceEnv(), log: (s) => logs.push(s) });

  expect(existsSync(layout.app)).toBe(true);
  expect(logs).toContain(`not an installed copy; left ${layout.app} in place`);
});

test("a launcher pointing at a different checkout is left alone", async () => {
  const root = tmp();
  const home = tempHome();
  const layout = layoutOf(join(root, "install", "app"), root);
  mkdirSync(layout.app, { recursive: true });
  mkdirSync(dirname(layout.launcher), { recursive: true });
  writeFileSync(layout.launcher, launcherText("/opt/node/bin/node", "/somewhere/else/app"));

  await uninstall(layout, home, { purge: false, confirm: async () => "delete", serviceEnv: fakeServiceEnv(), log: () => {} });

  expect(existsSync(layout.launcher)).toBe(true);
  // installDir removal is independent of the launcher check: this is still a managed install.
  expect(existsSync(layout.installDir!)).toBe(false);
});

test("a sibling checkout outside app/ and node/ survives", async () => {
  const root = tmp();
  const home = tempHome();
  const src = join(root, "src");
  const layout = layoutOf(join(src, "app"), root);
  mkdirSync(layout.app, { recursive: true });
  mkdirSync(layout.nodeDir!, { recursive: true });
  writeFileSync(join(layout.nodeDir!, NODE_MARKER), "");
  const sibling = join(src, "other");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "marker"), "keep me");

  await uninstall(layout, home, { purge: false, confirm: async () => "delete", serviceEnv: fakeServiceEnv(), log: () => {} });

  expect(existsSync(layout.app)).toBe(false);
  expect(existsSync(layout.nodeDir!)).toBe(false);
  expect(existsSync(sibling)).toBe(true);
  expect(readFileSync(join(sibling, "marker"), "utf8")).toBe("keep me");
  // installDir isn't empty (the sibling remains), so it's left in place too.
  expect(existsSync(layout.installDir!)).toBe(true);
});

test("a node/ japa didn't install survives", async () => {
  const root = tmp();
  const home = tempHome();
  const layout = layoutOf(join(root, "apps", "app"), root);
  mkdirSync(layout.app, { recursive: true });
  mkdirSync(layout.nodeDir!, { recursive: true });
  writeFileSync(join(layout.nodeDir!, "keep.txt"), "mine");

  await uninstall(layout, home, { purge: false, confirm: async () => "delete", serviceEnv: fakeServiceEnv(), log: () => {} });

  expect(existsSync(layout.app)).toBe(false);
  expect(readFileSync(join(layout.nodeDir!, "keep.txt"), "utf8")).toBe("mine");
});
