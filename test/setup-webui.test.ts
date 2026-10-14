// The rerun menu's Web UI section of `japa setup` (src/cli/webui-step.ts), driven through the fake prompter.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { configurable } from "../src/cli/configure.ts";
import { openSetupContext } from "../src/cli/context.ts";
import type { Exec } from "../src/cli/exec.ts";
import type { Choice } from "../src/cli/prompt.ts";
import { type ServiceEnv, unitPath } from "../src/cli/service.ts";
import { runSetup, type SetupOptions } from "../src/cli/setup.ts";
import { type Interfaces, parseHosts, parsePort, webuiAddresses } from "../src/cli/webui-step.ts";
import { REPO_EXTENSIONS, tempHome } from "./helpers.ts";
import { ENTER, scripted } from "./prompt-helpers.ts";

const IFACES: Interfaces = {
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
  eth0: [
    { address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.20/24" },
    { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "fe80::1/64", scopeid: 2 },
  ],
  tailscale0: [
    { address: "100.101.102.103", netmask: "255.255.255.255", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.101.102.103/32" },
  ],
};

const MENU = "What would you like to change?";
const SECTION = "What would you like to change about the web UI?";

function serviceEnv(exec: Exec = async () => ({ code: 1, stdout: "", stderr: "" })): ServiceEnv {
  return {
    platform: "linux",
    userHome: tempHome(),
    configHome: tempHome(),
    command: ["/home/x/.local/bin/japa", "daemon"],
    japaHome: tempHome(),
    customHome: false,
    path: "/usr/bin:/bin",
    user: "alice",
    exec,
  };
}

function options(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    interactive: true,
    service: false,
    whatsNew: false,
    env: {},
    serviceEnv: serviceEnv(),
    extensionDirs: [REPO_EXTENSIONS],
    log: () => {},
    interfaces: () => IFACES,
    ...overrides,
  };
}

const COS = { provider: "anthropic", modelId: "claude-x" };

/** A configured home (`models.cos` set), plus `extra` top-level keys. */
function configuredHome(extra: Record<string, unknown> = {}): string {
  const home = tempHome();
  writeFileSync(join(home, "settings.json"), `${JSON.stringify({ models: { cos: COS }, ...extra }, null, 2)}\n`);
  return home;
}

const settingsText = (home: string) => readFileSync(join(home, "settings.json"), "utf8");
const settings = (home: string) => JSON.parse(settingsText(home));
const webui = (home: string) => settings(home).extensions?.webui;

const pick = (label: string) => (choices: Choice<unknown>[]) => {
  const c = choices.find((x) => x.label.startsWith(label));
  if (c === undefined) throw new Error(`no choice "${label}" in ${choices.map((x) => x.label).join(", ")}`);
  return c.value;
};

/** Runs setup's rerun with `steps` (wrapped in entering the section and leaving it and the menu). */
async function run(home: string, steps: [string, unknown][], o: Partial<SetupOptions> = {}) {
  const p = scripted([[MENU, "WebUI"], ...steps, [SECTION, pick("Done")], [MENU, "Done"]]);
  const code = await runSetup(home, p, options(o));
  expect(code).toBe(0);
  p.done();
  return p;
}

test("the rerun menu lists Web UI between Integrations and Background service", async () => {
  const home = configuredHome();
  let labels: string[] = [];
  const p = scripted([
    [
      MENU,
      (choices: Choice<unknown>[]) => {
        labels = choices.map((c) => c.label);
        return "Done";
      },
    ],
  ]);
  await runSetup(home, p, options());
  p.done();
  expect(labels).toEqual(["Model and sign-in", "Integrations", "Web UI", "Background service", "Done"]);
});

test("a fresh section shows on, the default URL, defaults and the Docker note, never the token; Done writes nothing", async () => {
  const home = configuredHome();
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(join(home, "secrets", "webui.token"), "sekrit-token-value");
  const before = settingsText(home);
  const { exec, calls } = (() => {
    const calls: string[][] = [];
    const exec: Exec = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: args.includes("is-active") ? "active\n" : "", stderr: "" };
    };
    return { exec, calls };
  })();
  const env = serviceEnv(exec);
  mkdirSync(dirname(unitPath(env)), { recursive: true });
  writeFileSync(unitPath(env), "placeholder");
  const logs: string[] = [];

  const p = await run(home, [], { serviceEnv: env, log: (s) => logs.push(s) });

  const box = p.notes.join("\n");
  expect(box).toContain("State: on");
  expect(box).toContain("http://127.0.0.1:7337");
  expect(box).toContain("bind: 127.0.0.1 (default)");
  expect(box).toContain("port: 7337 (default)");
  expect(box).toContain("hosts: none (default)");
  expect(box).toContain("`--webui-port`, `--webui-bind`");
  expect(box.toLowerCase()).not.toContain("token");
  expect(box).not.toContain("sekrit");
  expect(p.asked.join("\n").toLowerCase()).not.toContain("token");
  expect(settingsText(home)).toBe(before);
  expect(calls.some((a) => a.includes("restart"))).toBe(false);
  expect(logs).not.toContain("Restarting japa to apply the changes.");
});

test("Port 8080 is saved, shown, and invalid ports re-ask without saving", async () => {
  const home = configuredHome();
  const p = await run(home, [
    [SECTION, pick("Port")],
    ["Port the web UI listens on", "70000"],
    ["Port the web UI listens on", "abc"],
    ["Port the web UI listens on", "8080"],
  ]);
  expect(webui(home)).toEqual({ port: 8080 });
  expect(p.notes.some((n) => n.includes("70000"))).toBe(true);
  expect(p.notes.some((n) => n.includes('"abc"'))).toBe(true);
  expect(p.notes.at(-1)).toContain("Open: http://127.0.0.1:8080");
  expect(p.notes.at(-1)).toContain("port: 8080");
});

test("Port prefilled with the current value; blank or 7337 removes it", async () => {
  const home = configuredHome({ extensions: { webui: { port: 9000 } } });
  const unchanged = settingsText(home);
  await run(home, [
    [SECTION, pick("Port")],
    ["Port the web UI listens on", "9000"],
  ]);
  expect(settingsText(home)).toBe(unchanged);
  let prefill: string | undefined;
  const p = scripted([
    [MENU, "WebUI"],
    [SECTION, pick("Port")],
    ["Port the web UI listens on", ENTER],
    [SECTION, pick("Port")],
    ["Port the web UI listens on", "7337"],
    [SECTION, pick("Done")],
    [MENU, "Done"],
  ]);
  const origText = p.text.bind(p);
  p.text = async (q, o) => {
    prefill ??= o?.initial;
    return origText(q, o);
  };
  await runSetup(home, p, options());
  p.done();
  expect(prefill).toBe("9000");
  expect(webui(home) ?? {}).toEqual({});

  const home2 = configuredHome({ extensions: { webui: { port: 9000 } } });
  await run(home2, [
    [SECTION, pick("Port")],
    ["Port the web UI listens on", ""],
  ]);
  expect(webui(home2) ?? {}).toEqual({});
});

test("Listen address offers this machine, each LAN/Tailscale address with its interface, all, and other", async () => {
  const home = configuredHome();
  let choices: Choice<unknown>[] = [];
  await run(home, [
    [SECTION, pick("Listen address")],
    [
      "Which address should the web UI listen on?",
      (c: Choice<unknown>[]) => {
        choices = c;
        return "192.168.1.20";
      },
    ],
  ]);
  // The interface and "Tailscale" are in the labels themselves: clack shows a hint only under the cursor.
  expect(choices.map((c) => c.label)).toEqual([
    "This machine only",
    "192.168.1.20 (eth0)",
    "100.101.102.103 (Tailscale, tailscale0)",
    "All addresses (0.0.0.0)",
    "Other…",
  ]);
  expect(webui(home)).toEqual({ bind: "192.168.1.20" });
});

test("Tailscale is recognised by the 100.64.0.0/10 range on any interface name", async () => {
  const home = configuredHome();
  let choices: Choice<unknown>[] = [];
  const ifaces: Interfaces = {
    wg0: [{ address: "100.64.0.5", netmask: "255.255.255.255", family: "IPv4", mac: "", internal: false, cidr: null }],
    eth1: [{ address: "100.128.0.5", netmask: "255.255.255.255", family: "IPv4", mac: "", internal: false, cidr: null }],
  };
  await run(
    home,
    [
      [SECTION, pick("Listen address")],
      ["Which address", (c: Choice<unknown>[]) => ((choices = c), "127.0.0.1")],
    ],
    { interfaces: () => ifaces },
  );
  expect(choices.map((c) => c.label)).toContain("100.64.0.5 (Tailscale, wg0)");
  expect(choices.map((c) => c.label)).toContain("100.128.0.5 (eth1)");
  expect(webui(home) ?? {}).toEqual({});
});

test("All addresses warns about plain HTTP first; declining saves nothing, confirming lists every address", async () => {
  const home = configuredHome();
  let warning = "";
  const p = await run(home, [
    [SECTION, pick("Listen address")],
    ["Which address", pick("All addresses")],
    ["plain HTTP", false],
    [SECTION, pick("Listen address")],
    ["Which address", pick("All addresses")],
    ["plain HTTP", (_: unknown) => ((warning = "seen"), true)],
  ]);
  expect(warning).toBe("seen");
  expect(webui(home)).toEqual({ bind: "0.0.0.0" });
  const last = p.notes.at(-1)!;
  expect(last).toContain("http://127.0.0.1:7337");
  expect(last).toContain("http://192.168.1.20:7337");
  expect(last).toContain("http://100.101.102.103:7337");
});

test("Other… refuses a non-IP and takes an IP; the current value is preselected and listed when unknown", async () => {
  const home = configuredHome();
  const p = await run(home, [
    [SECTION, pick("Listen address")],
    ["Which address", pick("Other")],
    ["IP address to listen on", "not-an-ip"],
    ["IP address to listen on", "10.9.8.7"],
  ]);
  expect(p.notes.some((n) => n.includes("not-an-ip"))).toBe(true);
  expect(webui(home)).toEqual({ bind: "10.9.8.7" });

  let labels: string[] = [];
  let preselected: unknown;
  await run(home, [
    [SECTION, pick("Listen address")],
    ["Which address", (c: Choice<unknown>[]) => ((labels = c.map((x) => x.label)), "10.9.8.7")],
  ]);
  const q = scripted([
    [MENU, "WebUI"],
    [SECTION, pick("Listen address")],
    ["Which address", ENTER],
    [SECTION, pick("Done")],
    [MENU, "Done"],
  ]);
  const origSelect = q.select.bind(q);
  q.select = async (question, choices, initial) => {
    if (question.startsWith("Which address")) preselected = initial;
    return origSelect(question, choices, initial);
  };
  await runSetup(home, q, options());
  q.done();
  expect(labels).toContain("10.9.8.7");
  expect(preselected).toBe("10.9.8.7");
  expect(webui(home)).toEqual({ bind: "10.9.8.7" });
});

test("Other… with 0.0.0.0 or :: asks the plain-HTTP confirmation too", async () => {
  const home = configuredHome();
  await run(home, [
    [SECTION, pick("Listen address")],
    ["Which address", pick("Other")],
    ["IP address to listen on", "::"],
    ["plain HTTP", false],
  ]);
  expect(webui(home) ?? {}).toEqual({});
  await run(home, [
    [SECTION, pick("Listen address")],
    ["Which address", pick("Other")],
    ["IP address to listen on", "0.0.0.0"],
    ["plain HTTP", true],
  ]);
  expect(webui(home)).toEqual({ bind: "0.0.0.0" });
});

test("This machine only removes bind", async () => {
  const home = configuredHome({ extensions: { webui: { bind: "192.168.1.20", port: 8000 } } });
  await run(home, [
    [SECTION, pick("Listen address")],
    ["Which address", pick("This machine only")],
  ]);
  expect(webui(home)).toEqual({ port: 8000 });
});

test("Host names are trimmed, lower-cased and deduplicated; invalid ones are refused by name; blank removes them", async () => {
  const home = configuredHome();
  const p = await run(home, [
    [SECTION, pick("Host names")],
    ["Extra host names", "http://x:1"],
    ["Extra host names", "10.0.0.1"],
    ["Extra host names", "a b"],
    ["Extra host names", "Japa.Example.Corp, foo.lan, FOO.lan"],
  ]);
  expect(webui(home)).toEqual({ hosts: ["japa.example.corp", "foo.lan"] });
  for (const bad of ['"http://x:1"', '"10.0.0.1"', '"a b"']) expect(p.notes.some((n) => n.includes(bad))).toBe(true);
  expect(p.notes.at(-1)).toContain("http://japa.example.corp:7337");
  expect(p.notes.at(-1)).toContain("http://foo.lan:7337");

  await run(home, [
    [SECTION, pick("Host names")],
    ["Extra host names", ""],
  ]);
  expect(webui(home) ?? {}).toEqual({});
});

test("Turn off writes enabled: false and shows off; Turn on removes it", async () => {
  const home = configuredHome();
  const p = await run(home, [[SECTION, pick("Turn off")]]);
  expect(webui(home)).toEqual({ enabled: false });
  expect(p.notes.at(-1)).toContain("State: off");
  expect(p.notes.at(-1)).toContain("off — turn it on to use it");

  let labels: string[] = [];
  await run(home, [[SECTION, (c: Choice<unknown>[]) => ((labels = c.map((x) => x.label)), pick("Turn on")(c))]]);
  expect(labels).toEqual(["Turn on", "Listen address", "Port", "Host names", "Reset to defaults", "Done"]);
  expect(webui(home) ?? {}).toEqual({});
});

test("Reset to defaults, once confirmed, clears only the web UI's keys", async () => {
  const extra = {
    extensions: { webui: { bind: "0.0.0.0", port: 8080, hosts: ["a.lan"], enabled: false, extra: 1 }, other: { x: 1 } },
    secrets: { adapter: "file" },
  };
  const home = configuredHome(extra);
  await run(home, [
    [SECTION, pick("Reset")],
    ["Reset", false],
  ]);
  expect(webui(home)).toEqual(extra.extensions.webui);

  await run(home, [
    [SECTION, pick("Reset")],
    ["Reset", true],
  ]);
  const s = settings(home);
  expect(s.extensions.webui).toEqual({ extra: 1 });
  expect(s.extensions.other).toEqual({ x: 1 });
  expect(s.models.cos).toEqual(COS);
  expect(s.secrets).toEqual({ adapter: "file" });
});

test("a saved change restarts an active service when setup finishes", async () => {
  const home = configuredHome();
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    return { code: 0, stdout: args.includes("is-active") ? "active\n" : "", stderr: "" };
  };
  const env = serviceEnv(exec);
  mkdirSync(dirname(unitPath(env)), { recursive: true });
  writeFileSync(unitPath(env), "placeholder");
  const logs: string[] = [];
  await run(
    home,
    [
      [SECTION, pick("Port")],
      ["Port", "8080"],
    ],
    { serviceEnv: env, log: (s) => logs.push(s) },
  );
  expect(logs).toContain("Restarting japa to apply the changes.");
  expect(calls).toContainEqual(["--user", "restart", "japa"]);
});

test("without a webui extension, the item says so and returns to the menu", async () => {
  const home = configuredHome();
  // Every packaged extension but webui, as a fork that removed it would have.
  const dir = join(tempHome(), "exts");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(REPO_EXTENSIONS)) {
    if (name === "webui") continue;
    mkdirSync(join(dir, name));
    const target = join(REPO_EXTENSIONS, name, "index.ts");
    writeFileSync(join(dir, name, "index.ts"), `export { default } from ${JSON.stringify(target)};\n`);
  }
  const p = scripted([
    [MENU, "WebUI"],
    [MENU, "Done"],
  ]);
  await runSetup(home, p, options({ extensionDirs: [dir] }));
  p.done();
  expect(p.notes).toContain("The web UI extension isn't installed.");
});

test("webui stays out of the Integrations step", async () => {
  const ctx = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  expect(ctx.extensions.some((e) => e.name === "webui")).toBe(true);
  expect(configurable(ctx.extensions).some((e) => e.name === "webui")).toBe(false);
});

test("pure helpers: addresses, ports, host names", () => {
  expect(webuiAddresses({}, IFACES)).toEqual(["http://127.0.0.1:7337"]);
  expect(webuiAddresses({ bind: "::1", port: 80 }, IFACES)).toEqual(["http://[::1]:80"]);
  expect(webuiAddresses({ bind: "::", hosts: ["a.lan"] }, IFACES)).toEqual([
    "http://127.0.0.1:7337",
    "http://192.168.1.20:7337",
    "http://100.101.102.103:7337",
    "http://a.lan:7337",
  ]);
  expect(webuiAddresses({ enabled: false }, IFACES)).toEqual(["off — turn it on to use it"]);
  expect(parsePort("1")).toEqual({ port: 1 });
  expect(parsePort("65535")).toEqual({ port: 65535 });
  expect("error" in parsePort("0")).toBe(true);
  expect("error" in parsePort("1.5")).toBe(true);
  expect(parsePort(" 7337 ")).toEqual({ port: undefined });
  expect(parseHosts("")).toEqual({ hosts: [] });
  expect("error" in parseHosts("x/y")).toBe(true);
  expect("error" in parseHosts("::1")).toBe(true);
  expect(parseHosts("My-Host")).toEqual({ hosts: ["my-host"] });
});
