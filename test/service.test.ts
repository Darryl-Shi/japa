import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { Exec, ExecResult } from "../src/cli/exec.ts";
import { layoutOf, writeLauncher } from "../src/cli/layout.ts";
import {
  daemonCommand,
  installService,
  isInstalled,
  logsCommand,
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
    command: ["/home/x/.local/bin/japa", "daemon"],
    japaHome: tmp(),
    customHome: false,
    path: "/usr/bin:/bin",
    user: "alice",
    exec: fakeExec().exec,
    ...overrides,
  };
}

test("unit quotes ExecStart, escaping \\ and \"; JAPA_HOME only with customHome", () => {
  const env = makeEnv({ command: ["/a b/japa", "daemon"] });

  const text = unitText(env);
  expect(text).toContain('ExecStart="/a b/japa" "daemon"');
  expect(text).toContain('Environment="PATH=/usr/bin:/bin"');
  expect(text).not.toContain("JAPA_HOME");

  expect(unitText({ ...env, command: ['/a"b/japa', "daemon"] })).toContain('ExecStart="/a\\"b/japa" "daemon"');
  expect(unitText({ ...env, command: ["/a\\b/japa", "daemon"] })).toContain('ExecStart="/a\\\\b/japa" "daemon"');

  const withHome = unitText({ ...env, customHome: true, japaHome: "/home/x/.japa" });
  expect(withHome).toContain('Environment="JAPA_HOME=/home/x/.japa"');
});

test("unit escapes systemd specifiers (%), and variables ($) in ExecStart's arguments, where systemd expands them", () => {
  const env = makeEnv({ command: ["/opt/100%/$HOME/japa", "/a%b/$HOME", "daemon"], path: "/a%b:$PATH", customHome: true, japaHome: "/h/50%" });

  const text = unitText(env);

  // systemd expands (and unescapes $$) only in the arguments, never in the executable path.
  expect(text).toContain('ExecStart="/opt/100%%/$HOME/japa" "/a%%b/$$HOME" "daemon"\n');
  expect(text).toContain('Environment="PATH=/a%%b:$PATH"\n'); // Environment= doesn't expand $
  expect(text).toContain('Environment="JAPA_HOME=/h/50%%"\n');
});

test("the service runs the launcher only when it points at this checkout", () => {
  const root = tmp();
  const layout = layoutOf(join(root, "share", "japa", "app"), root);
  const direct = ["/opt/node/bin/node", "--disable-warning=ExperimentalWarning", join(layout.app, "src/cli/main.ts"), "daemon"];

  expect(daemonCommand(layout, "/opt/node/bin/node")).toEqual(direct); // no launcher (e.g. npm link)

  writeLauncher({ ...layout, app: join(root, "elsewhere", "app") }, "/opt/node/bin/node");
  expect(daemonCommand(layout, "/opt/node/bin/node")).toEqual(direct); // another install's launcher

  writeLauncher(layout, "/opt/node/bin/node");
  expect(daemonCommand(layout, "/opt/node/bin/node")).toEqual([layout.launcher, "daemon"]);
});

test("the unit runs a checkout directly on its Node", () => {
  const command = ["/opt/my node/bin/node", "--disable-warning=ExperimentalWarning", "/src/ja&pa/src/cli/main.ts", "daemon"];

  expect(unitText(makeEnv({ command }))).toContain(
    'ExecStart="/opt/my node/bin/node" "--disable-warning=ExperimentalWarning" "/src/ja&pa/src/cli/main.ts" "daemon"\n',
  );
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

test("no systemd → unavailable reason mentions /etc/wsl.conf", async () => {
  const { exec } = fakeExec(() => ({ code: 1 }));
  const env = makeEnv({ exec });

  const reason = await unavailable(env);

  expect(reason).toContain("/etc/wsl.conf");
  expect(reason).toContain('run "japa daemon" yourself');
});

test("unavailable is undefined when systemd answers, and there's no service manager off Linux", async () => {
  const { exec, calls } = fakeExec(() => ({ code: 0 }));
  expect(await unavailable(makeEnv({ exec }))).toBeUndefined();
  calls.length = 0;
  expect(await unavailable(makeEnv({ platform: "darwin", exec }))).toBe("no supported service manager");
  expect(calls).toEqual([]);
});

test("off Linux nothing is installed and the service commands are no-ops", async () => {
  const { exec, calls } = fakeExec();
  const env = makeEnv({ platform: "darwin", exec });

  expect(isInstalled(env)).toBe(false);
  expect(await serviceState(env)).toBe("not installed");
  await installService(env, () => {});
  await stopService(env);
  await restartService(env);
  await uninstallService(env, () => {});

  expect(calls).toEqual([]);
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

test("serviceState on Linux: only inactive counts as stopped; activating (auto-restart) and failed are failed", async () => {
  const stateFor = async (answer: string) => {
    const { exec } = fakeExec((cmd, args) => (args.includes("is-active") ? { code: 3, stdout: `${answer}\n` } : {}));
    const env = makeEnv({ exec });
    mkdirSync(dirname(unitPath(env)), { recursive: true });
    writeFileSync(unitPath(env), unitText(env));
    return serviceState(env);
  };

  expect(await stateFor("inactive")).toBe("inactive");
  expect(await stateFor("activating")).toBe("failed");
  expect(await stateFor("failed")).toBe("failed");
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

test("stopService and restartService issue the systemd commands", async () => {
  const linux = fakeExec();
  const linuxEnv = makeEnv({ exec: linux.exec });
  await stopService(linuxEnv);
  await restartService(linuxEnv);
  expect(linux.calls).toEqual([
    { cmd: "systemctl", args: ["--user", "stop", "japa"] },
    { cmd: "systemctl", args: ["--user", "restart", "japa"] },
  ]);
});

test("logsCommand follows the unit's journal", () => {
  expect(logsCommand()).toEqual(["journalctl", ["--user", "-u", "japa", "-f"]]);
});

test("service.ts has no launchd code left", () => {
  const text = readFileSync(fileURLToPath(new URL("../src/cli/service.ts", import.meta.url)), "utf8");
  expect(text).not.toMatch(/launchd|launchctl|plist|darwin|macOS/i);
});

test("logs/ is ignored by the workspace git", () => {
  const home = tempHome();
  ensureWorkspace(home);
  expect(readFileSync(join(home, ".gitignore"), "utf8")).toContain("logs/");
});
