import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import type { Exec, ExecResult } from "../src/cli/exec.ts";
import { layoutOf, launcherText, writeLauncher } from "../src/cli/layout.ts";
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

test('--purge without "delete" removes nothing', async () => {
  const root = tmp();
  const home = tempHome();
  const layout = layoutOf(join(root, "install", "app"), root);
  mkdirSync(layout.app, { recursive: true });
  writeLauncher(layout, "/opt/node/bin/node");
  const logs: string[] = [];

  await uninstall(layout, home, { purge: true, confirm: async () => "nope", serviceEnv: fakeServiceEnv(), log: (s) => logs.push(s) });

  expect(existsSync(home)).toBe(true);
  expect(logs).toContain(`kept ${home}`);
  // The launcher and installDir are unaffected by purge: only `home` is gated on confirm().
  expect(existsSync(layout.launcher)).toBe(false);
  expect(existsSync(layout.installDir!)).toBe(false);
});

test('--purge with "delete" removes home', async () => {
  const root = tmp();
  const home = tempHome();
  const layout = layoutOf(join(root, "install", "app"), root);
  mkdirSync(layout.app, { recursive: true });
  const logs: string[] = [];

  await uninstall(layout, home, { purge: true, confirm: async () => "delete", serviceEnv: fakeServiceEnv(), log: (s) => logs.push(s) });

  expect(existsSync(home)).toBe(false);
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
