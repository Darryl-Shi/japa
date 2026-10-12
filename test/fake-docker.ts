// A fake `docker` CLI for test/install-docker.test.ts and test/docker-launcher.test.ts (docs/spec.md §8): a temp dir
// holding an executable `docker` (a sh wrapper exec'ing this test's Node on a small JS script) backed by a JSON
// state file. Every invocation's argv is logged (one JSON array per line) so tests can assert on exact calls.
//
// It emulates just what install.sh and the host launcher call: info, container/image/volume/network inspect,
// volume/network create/rm, build, run, rm -f, start, ps -a --filter label=... --format, and exec.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FakeContainer {
  labels: Record<string, string>;
  /** Image id (what `{{.Image}}` prints). */
  image: string;
  running: boolean;
  /** The `docker run` argv that created it, when it was created by the fake. */
  runArgs?: string[];
}

/** An `exec` answer: applies when every string in `match` is one of the exec'd command's args (after the container). */
export interface ExecRule {
  match: string[];
  stdout?: string;
  stderr?: string;
  status?: number;
}

export interface FakeState {
  /** `docker info` fails (Docker not usable). */
  infoFails: boolean;
  /** Runtimes `docker info --format '{{json .Runtimes}}'` lists. */
  runtimes: string[];
  /** `docker build` fails. */
  buildFails: boolean;
  /** The id `docker build -t IMG` gives IMG. */
  buildImageId: string;
  /** `docker run` fails. */
  runFails: boolean;
  /** What `systemctl is-system-running` prints inside a container. */
  systemState: string;
  images: Record<string, string>;
  containers: Record<string, FakeContainer>;
  volumes: string[];
  networks: string[];
  execRules: ExecRule[];
}

export interface FakeDocker {
  /** The dir holding `docker` (and any other fakes): put it first on PATH. */
  binDir: string;
  stateFile: string;
  logFile: string;
  state(): FakeState;
  update(fn: (s: FakeState) => void): void;
  /** Every invocation's argv (without "docker"), in order. */
  calls(): string[][];
  /** Calls whose first arg is `sub` (e.g. "run", "exec"). */
  callsOf(sub: string): string[][];
  clearLog(): void;
}

export const DEFAULT_STATE: FakeState = {
  infoFails: false,
  runtimes: ["io.containerd.runc.v2", "runc", "sysbox-runc"],
  buildFails: false,
  buildImageId: "sha256:image1",
  runFails: false,
  systemState: "running",
  images: {},
  containers: {},
  volumes: [],
  networks: [],
  execRules: [],
};

const SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const [, , stateFile, logFile, ...argv] = process.argv;
fs.appendFileSync(logFile, JSON.stringify(argv) + "\n");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const out = (s) => process.stdout.write(s);
const fail = (msg, code = 1) => { process.stderr.write(msg + "\n"); process.exit(code); };

function render(fmt, ctx) {
  return fmt.replace(/\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
    let m;
    if ((m = /^index \.Config\.Labels "([^"]*)"$/.exec(expr))) return (ctx.labels || {})[m[1]] ?? "";
    if ((m = /^\.Label "([^"]*)"$/.exec(expr))) return (ctx.labels || {})[m[1]] ?? "";
    if (expr === "json .Runtimes") {
      const r = {};
      for (const name of state.runtimes) r[name] = { path: name };
      return JSON.stringify(r);
    }
    if (expr === ".Image") return ctx.image ?? "";
    if (expr === ".Id" || expr === ".ID") return ctx.id ?? "";
    if (expr === ".State.Running") return ctx.running ? "true" : "false";
    if (expr === ".State") return ctx.running ? "running" : "exited";
    if (expr === ".Names" || expr === ".Name") return ctx.name ?? "";
    if (expr === "json .") return JSON.stringify(ctx);
    return "<no value>";
  });
}

// Splits "-f FMT" / "--format FMT" / "--format=FMT" off args; returns [fmt, rest].
function takeFormat(args) {
  let fmt;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a === "--format") fmt = args[++i];
    else if (a.startsWith("--format=")) fmt = a.slice(9);
    else rest.push(a);
  }
  return [fmt, rest];
}

function containerCtx(name) {
  const c = state.containers[name];
  return { name, id: "id-" + name, ...c };
}

function inspectObjects(kind, args) {
  const [fmt, names] = takeFormat(args);
  if (names.length === 0) fail("\"docker " + kind + " inspect\" requires at least 1 argument.");
  let status = 0;
  for (const n of names) {
    let ctx;
    if (kind === "container") ctx = state.containers[n] ? containerCtx(n) : undefined;
    else if (kind === "image") ctx = state.images[n] !== undefined ? { name: n, id: state.images[n] } : undefined;
    else if (kind === "volume") ctx = state.volumes.includes(n) ? { name: n } : undefined;
    else if (kind === "network") ctx = state.networks.includes(n) ? { name: n } : undefined;
    if (!ctx) {
      process.stderr.write("Error: No such " + kind + ": " + n + "\n");
      status = 1;
      continue;
    }
    out((fmt !== undefined ? render(fmt, ctx) : JSON.stringify([ctx])) + "\n");
  }
  process.exit(status);
}

function createOrRm(kind, sub, args) {
  const list = kind === "volume" ? state.volumes : state.networks;
  const names = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--label" || args[i] === "-l" || args[i] === "-d" || args[i] === "--driver") i++;
    else if (args[i].startsWith("-")) continue;
    else names.push(args[i]);
  }
  if (sub === "create") {
    for (const n of names) {
      if (list.includes(n)) {
        if (kind === "network") fail("Error response from daemon: network with name " + n + " already exists");
      } else list.push(n);
      out(n + "\n");
    }
  } else {
    let status = 0;
    for (const n of names) {
      const i = list.indexOf(n);
      if (i < 0) { process.stderr.write("Error: No such " + kind + ": " + n + "\n"); status = 1; }
      else { list.splice(i, 1); out(n + "\n"); }
    }
    save();
    process.exit(status);
  }
  save();
}

const VALUE_OPTS = new Set(["--name", "--hostname", "-h", "--restart", "--network", "--net", "-v", "--volume", "-p", "--publish", "--label", "-l", "-e", "--env", "-w", "--workdir", "-u", "--user", "--runtime", "--mount", "--entrypoint"]);

function parseRunLike(args) {
  const opts = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) break;
    if (a.includes("=") && a.startsWith("--")) { opts.push([a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]); continue; }
    if (VALUE_OPTS.has(a)) { opts.push([a, args[++i]]); continue; }
    opts.push([a, true]);
  }
  return { opts, target: args[i], rest: args.slice(i + 1) };
}

const [sub, ...args] = argv;
switch (sub) {
  case "info": {
    if (state.infoFails) fail("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock");
    const [fmt] = takeFormat(args);
    if (fmt !== undefined) out(render(fmt, {}) + "\n");
    else out("Runtimes: " + state.runtimes.join(" ") + "\n");
    break;
  }
  case "container": {
    const [verb, ...rest] = args;
    if (verb === "inspect") inspectObjects("container", rest);
    fail("fake docker: unsupported: container " + verb);
    break;
  }
  case "inspect": inspectObjects("container", args); break;
  case "image": {
    const [verb, ...rest] = args;
    if (verb === "inspect") inspectObjects("image", rest);
    fail("fake docker: unsupported: image " + verb);
    break;
  }
  case "volume":
  case "network": {
    const [verb, ...rest] = args;
    if (verb === "inspect") inspectObjects(sub, rest);
    if (verb === "create" || verb === "rm") { createOrRm(sub, verb, rest); break; }
    fail("fake docker: unsupported: " + sub + " " + verb);
    break;
  }
  case "build": {
    let tag;
    for (let i = 0; i < args.length; i++) if (args[i] === "-t" || args[i] === "--tag") tag = args[++i];
    if (state.buildFails) fail("ERROR: failed to solve: fake build failure");
    if (tag) state.images[tag] = state.buildImageId;
    save();
    break;
  }
  case "run": {
    const { opts, target } = parseRunLike(args);
    if (state.runFails) fail("docker: Error response from daemon: fake run failure.", 125);
    const name = (opts.find(([k]) => k === "--name") || [])[1];
    if (!name) fail("fake docker: run without --name");
    if (state.containers[name]) fail("docker: Error response from daemon: Conflict. The container name \"/" + name + "\" is already in use.", 125);
    const labels = {};
    for (const [k, v] of opts) if (k === "--label" || k === "-l") { const s = String(v); labels[s.slice(0, s.indexOf("="))] = s.slice(s.indexOf("=") + 1); }
    state.containers[name] = { labels, image: state.images[target] ?? target, running: true, runArgs: args };
    save();
    out("id-" + name + "\n");
    break;
  }
  case "rm": {
    const names = args.filter((a) => !a.startsWith("-"));
    let status = 0;
    for (const n of names) {
      if (state.containers[n]) { delete state.containers[n]; out(n + "\n"); }
      else { process.stderr.write("Error response from daemon: No such container: " + n + "\n"); status = 1; }
    }
    save();
    process.exit(status);
    break;
  }
  case "start": {
    let status = 0;
    for (const n of args.filter((a) => !a.startsWith("-"))) {
      if (state.containers[n]) { state.containers[n].running = true; out(n + "\n"); }
      else { process.stderr.write("Error response from daemon: No such container: " + n + "\n"); status = 1; }
    }
    save();
    process.exit(status);
    break;
  }
  case "ps": {
    let all = false;
    const filters = [];
    let fmt;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-a" || a === "--all") all = true;
      else if (a === "--filter" || a === "-f") filters.push(args[++i]);
      else if (a === "--format") fmt = args[++i];
    }
    for (const [name, c] of Object.entries(state.containers)) {
      if (!all && !c.running) continue;
      const ok = filters.every((f) => {
        const m = /^label=([^=]*)(?:=(.*))?$/.exec(f);
        if (!m) return true;
        if (!(m[1] in c.labels)) return false;
        return m[2] === undefined || c.labels[m[1]] === m[2];
      });
      if (ok) out(render(fmt ?? "{{.Names}}", containerCtx(name)) + "\n");
    }
    break;
  }
  case "exec": {
    const { target, rest } = parseRunLike(args);
    const c = state.containers[target];
    if (!c) fail("Error response from daemon: No such container: " + target);
    if (!c.running) fail("Error response from daemon: container " + target + " is not running");
    if (rest[0] === "systemctl" && rest[1] === "is-system-running") { out(state.systemState + "\n"); break; }
    const rule = state.execRules.find((r) => r.match.every((m) => rest.includes(m)));
    if (rule) {
      if (rule.stdout) out(rule.stdout);
      if (rule.stderr) process.stderr.write(rule.stderr);
      process.exit(rule.status ?? 0);
    }
    break;
  }
  default:
    fail("fake docker: unsupported command: " + argv.join(" "));
}
`;

/** Creates a fake docker in a new temp dir, with `initial` merged over DEFAULT_STATE. */
export function createFakeDocker(initial: Partial<FakeState> = {}): FakeDocker {
  const binDir = mkdtempSync(join(tmpdir(), "japa-fake-docker-"));
  const stateFile = join(binDir, "state.json");
  const logFile = join(binDir, "calls.log");
  const script = join(binDir, "fake-docker.cjs");
  writeFileSync(script, SCRIPT);
  writeFileSync(stateFile, JSON.stringify({ ...structuredClone(DEFAULT_STATE), ...structuredClone(initial) }, null, 2));
  writeFileSync(logFile, "");
  const docker = join(binDir, "docker");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(docker, `#!/bin/sh\nexec ${q(process.execPath)} ${q(script)} ${q(stateFile)} ${q(logFile)} "$@"\n`);
  chmodSync(docker, 0o755);

  const state = (): FakeState => JSON.parse(readFileSync(stateFile, "utf8")) as FakeState;
  const calls = (): string[][] =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as string[]);
  return {
    binDir,
    stateFile,
    logFile,
    state,
    update(fn) {
      const s = state();
      fn(s);
      writeFileSync(stateFile, JSON.stringify(s, null, 2));
    },
    calls,
    callsOf: (sub) => calls().filter((c) => c[0] === sub),
    clearLog: () => writeFileSync(logFile, ""),
  };
}

/** Writes an executable fake `name` into `dir` running the sh `body`. */
export function writeFakeTool(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A PATH with the fake first, then this test's Node and the system tools. */
export function fakePath(fake: FakeDocker): string {
  return [fake.binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
}

/** The host launcher's text, extracted from install.sh's docker_launcher_text() heredoc. */
export function launcherFromInstallSh(installSh: string): string {
  const text = readFileSync(installSh, "utf8");
  const start = text.indexOf("cat <<'LAUNCHER'\n");
  if (start < 0 || !existsSync(installSh)) throw new Error("no LAUNCHER heredoc in install.sh");
  const body = text.slice(start + "cat <<'LAUNCHER'\n".length);
  const end = body.indexOf("\nLAUNCHER\n");
  if (end < 0) throw new Error("unterminated LAUNCHER heredoc in install.sh");
  return body.slice(0, end + 1);
}

/** A labelled japa instance container, for seeding state. */
export function instance(name: string, opts: { branch?: string; port?: number; running?: boolean; image?: string } = {}): [string, FakeContainer] {
  return [
    `japa-${name}`,
    {
      labels: { "japa.instance": name, "japa.branch": opts.branch ?? "main", "japa.desktopPort": String(opts.port ?? 6080) },
      image: opts.image ?? "sha256:image1",
      running: opts.running ?? true,
    },
  ];
}
