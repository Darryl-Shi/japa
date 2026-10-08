import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Exec, ExecResult } from "../src/cli/exec.ts";
import {
  installService,
  isInstalled,
  logsCommand,
  plistPath,
  plistText,
  restartService,
  type ServiceEnv,
  serviceState,
  startService,
  stopService,
  unavailable,
  uninstallService,
  unitPath,
  unitText,
} from "../src/cli/service.ts";
import { ensureWorkspace } from "../src/kernel/workspace.ts";
import { tempHome } from "./helpers.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "japa-service-"));

/** A fake `Exec` that records every call and answers via `answer(cmd, args)` (default: success, no output). */
function fakeExec(answer: (cmd: string, args: string[]) => Partial<ExecResult> = () => ({})) {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const a = answer(cmd, args);
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { exec, calls };
}

function makeEnv(overrides: Partial<ServiceEnv> = {}): ServiceEnv {
  return {
    platform: "linux",
    userHome: tmp(),
    configHome: tmp(),
    launcher: "/home/x/.local/bin/japa",
    japaHome: tmp(),
    customHome: false,
    path: "/usr/bin:/bin",
    user: "alice",
    uid: 1000,
    exec: fakeExec().exec,
    ...overrides,
  };
}

test("unit quotes ExecStart, escaping \\ and \"; JAPA_HOME only with customHome", () => {
  const env = makeEnv({ launcher: "/a b/japa" });

  const text = unitText(env);
  expect(text).toContain('ExecStart="/a b/japa" daemon');
  expect(text).toContain('Environment="PATH=/usr/bin:/bin"');
  expect(text).not.toContain("JAPA_HOME");

  expect(unitText({ ...env, launcher: '/a"b/japa' })).toContain('ExecStart="/a\\"b/japa" daemon');
  expect(unitText({ ...env, launcher: "/a\\b/japa" })).toContain('ExecStart="/a\\\\b/japa" daemon');

  const withHome = unitText({ ...env, customHome: true, japaHome: "/home/x/.japa" });
  expect(withHome).toContain('Environment="JAPA_HOME=/home/x/.japa"');
});

test("plist escapes values and logs to <home>/logs/daemon.log", () => {
  const env = makeEnv({ platform: "darwin", launcher: "/a&b/japa", japaHome: "/home/x/.japa", customHome: true, path: "/usr/bin" });

  const text = plistText(env);
  expect(text).toContain("<string>/a&amp;b/japa</string>");
  expect(text).toContain(`<string>${join("/home/x/.japa", "logs", "daemon.log")}</string>`);
  expect(text).toContain("<key>PATH</key>\n\t\t<string>/usr/bin</string>");
  expect(text).toContain("<key>JAPA_HOME</key>\n\t\t<string>/home/x/.japa</string>");
});

test("install writes, reloads, enables, starts and lingers", async () => {
  const { exec, calls } = fakeExec();
  const env = makeEnv({ exec });
  const logs: string[] = [];

  await installService(env, (s) => logs.push(s));

  expect(readFileSync(unitPath(env), "utf8")).toBe(unitText(env));
  expect(calls).toEqual([
    { cmd: "systemctl", args: ["--user", "daemon-reload"] },
    { cmd: "systemctl", args: ["--user", "enable", "japa"] },
    { cmd: "systemctl", args: ["--user", "is-active", "japa"] },
    { cmd: "systemctl", args: ["--user", "start", "japa"] },
    { cmd: "loginctl", args: ["enable-linger", "alice"] },
  ]);
  expect(logs).toEqual([]);
});

test("a second install with the same text does not reload", async () => {
  const { exec, calls } = fakeExec();
  const env = makeEnv({ exec });

  await installService(env, () => {});
  calls.length = 0;
  await installService(env, () => {});

  expect(calls.some((c) => c.args.includes("daemon-reload"))).toBe(false);
  // The other steps are idempotent and still run every time.
  expect(calls.some((c) => c.args.includes("start"))).toBe(true);
});

test("a lingering failure prints the sudo line", async () => {
  const { exec } = fakeExec((cmd) => (cmd === "loginctl" ? { code: 1, stderr: "no polkit" } : {}));
  const env = makeEnv({ exec, user: "alice" });
  const logs: string[] = [];

  await installService(env, (s) => logs.push(s));

  expect(logs).toEqual(["to keep japa running after you log out: sudo loginctl enable-linger alice"]);
});

test("macOS install writes the plist, ignores a failed bootout, and bootstraps", async () => {
  const { exec, calls } = fakeExec((cmd, args) => (args[0] === "bootout" ? { code: 1 } : {}));
  const env = makeEnv({ platform: "darwin", exec, uid: 501 });

  await installService(env, () => {});

  expect(readFileSync(plistPath(env), "utf8")).toBe(plistText(env));
  expect(calls).toEqual([
    { cmd: "launchctl", args: ["bootout", "gui/501", plistPath(env)] },
    { cmd: "launchctl", args: ["print", "gui/501/dev.japa.daemon"] },
    { cmd: "launchctl", args: ["bootstrap", "gui/501", plistPath(env)] },
  ]);
});

test("a second macOS install with the same plist does not bootout", async () => {
  const { exec, calls } = fakeExec();
  const env = makeEnv({ platform: "darwin", exec, uid: 501 });

  await installService(env, () => {});
  calls.length = 0;
  await installService(env, () => {});

  expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
  // The ensure-running step is still unconditional.
  expect(calls.some((c) => c.args[0] === "bootstrap")).toBe(true);
});

test("macOS install refuses while a foreground daemon holds the lock", async () => {
  const { exec, calls } = fakeExec();
  const home = tmp();
  writeFileSync(join(home, "daemon.lock"), String(process.pid));
  const env = makeEnv({ platform: "darwin", exec, japaHome: home, uid: 501 });

  await expect(installService(env, () => {})).rejects.toThrow(
    `japa is already running in the foreground (pid ${process.pid}); stop it first`,
  );
  expect(calls.some((c) => c.args[0] === "bootstrap")).toBe(false);
});

test("no systemd → unavailable reason mentions /etc/wsl.conf", async () => {
  const { exec } = fakeExec(() => ({ code: 1 }));
  const env = makeEnv({ exec });

  const reason = await unavailable(env);

  expect(reason).toContain("/etc/wsl.conf");
  expect(reason).toContain('run "japa daemon" yourself');
});

test("unavailable is undefined when systemd answers, and always on macOS", async () => {
  const { exec } = fakeExec(() => ({ code: 0 }));
  expect(await unavailable(makeEnv({ exec }))).toBeUndefined();
  expect(await unavailable(makeEnv({ platform: "darwin" }))).toBeUndefined();
});

test("start refuses while a foreground daemon holds the lock", async () => {
  const { exec, calls } = fakeExec();
  const home = tmp();
  writeFileSync(join(home, "daemon.lock"), String(process.pid));
  const env = makeEnv({ exec, japaHome: home });

  await expect(startService(env, () => {})).rejects.toThrow(
    `japa is already running in the foreground (pid ${process.pid}); stop it first`,
  );
  expect(calls).toEqual([]);
});

test("isInstalled and serviceState reflect the unit file and systemctl is-active", async () => {
  const { exec } = fakeExec((cmd, args) => (args.includes("is-active") ? { code: 0, stdout: "active\n" } : {}));
  const env = makeEnv({ exec });

  expect(isInstalled(env)).toBe(false);
  expect(await serviceState(env)).toBe("not installed");

  mkdirSync(dirname(unitPath(env)), { recursive: true });
  writeFileSync(unitPath(env), unitText(env));

  expect(isInstalled(env)).toBe(true);
  expect(await serviceState(env)).toBe("active");
});

test("serviceState on macOS reads launchctl print's state field, not just its exit code", async () => {
  const waiting = fakeExec(() => ({ code: 0, stdout: "\tstate = waiting\n" }));
  const waitingEnv = makeEnv({ platform: "darwin", exec: waiting.exec, uid: 501 });
  mkdirSync(dirname(plistPath(waitingEnv)), { recursive: true });
  writeFileSync(plistPath(waitingEnv), "placeholder");
  expect(await serviceState(waitingEnv)).toBe("inactive");

  const running = fakeExec(() => ({ code: 0, stdout: "\tstate = running\n" }));
  const runningEnv = makeEnv({ platform: "darwin", exec: running.exec, uid: 501 });
  mkdirSync(dirname(plistPath(runningEnv)), { recursive: true });
  writeFileSync(plistPath(runningEnv), "placeholder");
  expect(await serviceState(runningEnv)).toBe("active");
});

test("uninstallService stops, disables and removes the unit file", async () => {
  const env = makeEnv();
  mkdirSync(dirname(unitPath(env)), { recursive: true });
  writeFileSync(unitPath(env), "placeholder");
  const { exec, calls } = fakeExec();

  await uninstallService({ ...env, exec }, () => {});

  expect(calls).toEqual([
    { cmd: "systemctl", args: ["--user", "disable", "--now", "japa"] },
    { cmd: "systemctl", args: ["--user", "daemon-reload"] },
  ]);
  expect(existsSync(unitPath(env))).toBe(false);
});

test("stopService and restartService issue the systemd / launchd commands", async () => {
  const linux = fakeExec();
  const linuxEnv = makeEnv({ exec: linux.exec });
  await stopService(linuxEnv);
  await restartService(linuxEnv);
  expect(linux.calls).toEqual([
    { cmd: "systemctl", args: ["--user", "stop", "japa"] },
    { cmd: "systemctl", args: ["--user", "restart", "japa"] },
  ]);

  const mac = fakeExec();
  const macEnv = makeEnv({ platform: "darwin", exec: mac.exec, uid: 501 });
  await stopService(macEnv);
  await restartService(macEnv);
  expect(mac.calls).toEqual([
    { cmd: "launchctl", args: ["bootout", "gui/501", plistPath(macEnv)] },
    { cmd: "launchctl", args: ["kickstart", "-k", "gui/501/dev.japa.daemon"] },
  ]);
});

test("logsCommand: journalctl on Linux, tail on macOS", () => {
  expect(logsCommand(makeEnv())).toEqual(["journalctl", ["--user", "-u", "japa", "-f"]]);
  expect(logsCommand(makeEnv({ platform: "darwin", japaHome: "/home/x/.japa" }))).toEqual([
    "tail",
    ["-f", join("/home/x/.japa", "logs", "daemon.log")],
  ]);
});

test("logs/ is ignored by the workspace git", () => {
  const home = tempHome();
  ensureWorkspace(home);
  expect(readFileSync(join(home, ".gitignore"), "utf8")).toContain("logs/");
});
