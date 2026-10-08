import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Exec, ExecResult } from "../src/cli/exec.ts";
import { layoutOf, writeLauncher } from "../src/cli/layout.ts";
import {
  daemonCommand,
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
    command: ["/home/x/.local/bin/japa", "daemon"],
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

test("plist escapes values and logs to <home>/logs/daemon.log", () => {
  const env = makeEnv({ platform: "darwin", command: ["/a&b/japa", "daemon"], japaHome: "/home/x/.japa", customHome: true, path: "/usr/bin" });

  const text = plistText(env);
  expect(text).toContain("<string>/a&amp;b/japa</string>");
  expect(text).toContain(`<string>${join("/home/x/.japa", "logs", "daemon.log")}</string>`);
  expect(text).toContain("<key>PATH</key>\n\t\t<string>/usr/bin</string>");
  expect(text).toContain("<key>JAPA_HOME</key>\n\t\t<string>/home/x/.japa</string>");
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

test("unit and plist run a checkout directly on its Node", () => {
  const command = ["/opt/my node/bin/node", "--disable-warning=ExperimentalWarning", "/src/ja&pa/src/cli/main.ts", "daemon"];

  expect(unitText(makeEnv({ command }))).toContain(
    'ExecStart="/opt/my node/bin/node" "--disable-warning=ExperimentalWarning" "/src/ja&pa/src/cli/main.ts" "daemon"\n',
  );
  expect(plistText(makeEnv({ platform: "darwin", command }))).toContain(
    [
      "\t<key>ProgramArguments</key>",
      "\t<array>",
      "\t\t<string>/opt/my node/bin/node</string>",
      "\t\t<string>--disable-warning=ExperimentalWarning</string>",
      "\t\t<string>/src/ja&amp;pa/src/cli/main.ts</string>",
      "\t\t<string>daemon</string>",
      "\t</array>",
    ].join("\n"),
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

test("macOS install creates <japaHome>/logs before bootstrapping (launchd won't create it)", async () => {
  const japaHome = join(tmp(), "home");
  let logsExisted = false;
  const { exec } = fakeExec((cmd, args) => {
    if (args[0] === "bootstrap") logsExisted = existsSync(join(japaHome, "logs"));
    return {};
  });
  const env = makeEnv({ platform: "darwin", exec, uid: 501, japaHome });

  await installService(env, () => {});

  expect(logsExisted).toBe(true);
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

test("serviceState on macOS reads launchctl print's state field, not just its exit code", async () => {
  const waiting = fakeExec(() => ({ code: 0, stdout: "\tstate = waiting\n" }));
  const waitingEnv = makeEnv({ platform: "darwin", exec: waiting.exec, uid: 501 });
  mkdirSync(dirname(plistPath(waitingEnv)), { recursive: true });
  writeFileSync(plistPath(waitingEnv), "placeholder");
  expect(await serviceState(waitingEnv)).toBe("failed"); // loaded but not running: it exited and wasn't stopped

  const unloaded = fakeExec(() => ({ code: 113, stdout: "" }));
  const unloadedEnv = makeEnv({ platform: "darwin", exec: unloaded.exec, uid: 501 });
  mkdirSync(dirname(plistPath(unloadedEnv)), { recursive: true });
  writeFileSync(plistPath(unloadedEnv), "placeholder");
  expect(await serviceState(unloadedEnv)).toBe("inactive"); // booted out, as `japa service stop` does

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
