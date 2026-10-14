// The rerun menu's "Web UI" section of `japa setup`: shows how the `webui` extension is set up (on/off, the
// addresses to open, bind/port/hosts) and changes each setting with guided choices, saving each change straight
// into `extensions.webui` of the user's settings.json. Authentication (the token) is deliberately not part of it.
import type { JsonObject } from "@earendil-works/pi-durable";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { JapaExtension } from "../kernel/extension.ts";
import { message } from "../kernel/loader.ts";
import { settingsSchema } from "../kernel/settings-tools.ts";
import { readUserSettings, saveSettings, setPath, validateExtensionSettings } from "../kernel/settings.ts";
import type { SetupContext } from "./context.ts";
import type { Choice, Prompter } from "./prompt.ts";

export const WEBUI = "webui";
export const DEFAULT_BIND = "127.0.0.1";
export const DEFAULT_PORT = 7337;
const ALL = "0.0.0.0";

export const DOCKER_NOTE =
  "In a Docker instance, the host port and address are set by the installer (`--webui-port`, `--webui-bind`); " +
  "keep these at their defaults there.";

/** The shape of `os.networkInterfaces()`, injectable for tests. */
export type Interfaces = ReturnType<typeof networkInterfaces>;

export type WebuiStepOptions = {
  /** The network interfaces to offer and show; default `os.networkInterfaces()`. */
  interfaces?: () => Interfaces;
};

/** A detected non-internal IPv4 address and the interface it's on. */
export type LocalAddress = { address: string; iface: string; tailscale: boolean };

/** Whether `address` (IPv4) is in Tailscale's CGNAT range 100.64.0.0/10. */
function inCgnat(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** Every non-internal IPv4 address in `interfaces`, once each, in interface order. */
export function localAddresses(interfaces: Interfaces): LocalAddress[] {
  const seen = new Set<string>();
  const result: LocalAddress[] = [];
  for (const [iface, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      const family = info.family as string | number;
      if (info.internal || (family !== "IPv4" && family !== 4) || seen.has(info.address)) continue;
      seen.add(info.address);
      result.push({ address: info.address, iface, tailscale: inCgnat(info.address) || /^tailscale/i.test(iface) });
    }
  }
  return result;
}

/** The web UI's own saved settings, as they read from `extensions.webui`. */
export type WebuiSettings = { enabled?: unknown; bind?: unknown; port?: unknown; hosts?: unknown };

const bindOf = (s: WebuiSettings) => (typeof s.bind === "string" && s.bind !== "" ? s.bind : DEFAULT_BIND);
const portOf = (s: WebuiSettings) => (typeof s.port === "number" ? s.port : DEFAULT_PORT);
const hostsOf = (s: WebuiSettings) =>
  Array.isArray(s.hosts) ? s.hosts.filter((h): h is string => typeof h === "string") : [];
const isOn = (s: WebuiSettings) => s.enabled !== false;

const url = (host: string, port: number) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

/** The address(es) to open the web UI at, from its settings and the network interfaces (a pure function); a
 * single "off — ..." line when it's turned off. */
export function webuiAddresses(s: WebuiSettings, interfaces: Interfaces): string[] {
  if (!isOn(s)) return ["off — turn it on to use it"];
  const bind = bindOf(s);
  const port = portOf(s);
  const urls =
    bind === ALL || bind === "::"
      ? [url(DEFAULT_BIND, port), ...localAddresses(interfaces).map((a) => url(a.address, port))]
      : [url(bind, port)];
  for (const name of hostsOf(s)) urls.push(url(name, port));
  return [...new Set(urls)];
}

/** The overview box's text. */
export function overview(s: WebuiSettings, interfaces: Interfaces): string {
  const addresses = webuiAddresses(s, interfaces);
  const hosts = hostsOf(s);
  return [
    `State: ${isOn(s) ? "on" : "off"}`,
    addresses.length === 1 ? `Open: ${addresses[0]}` : `Open:\n${addresses.map((a) => `  ${a}`).join("\n")}`,
    `bind: ${s.bind === undefined ? `${DEFAULT_BIND} (default)` : String(s.bind)}`,
    `port: ${s.port === undefined ? `${DEFAULT_PORT} (default)` : String(s.port)}`,
    `hosts: ${s.hosts === undefined ? "none (default)" : hosts.length > 0 ? hosts.join(", ") : "none"}`,
    "",
    DOCKER_NOTE,
  ].join("\n");
}

/** The port in `answer`: undefined (the default) for blank or 7337, a number for 1-65535, or an error message. */
export function parsePort(answer: string): { port: number | undefined } | { error: string } {
  const text = answer.trim();
  if (text === "") return { port: undefined };
  if (!/^\d+$/.test(text)) return { error: `Not a port: "${text}" (a whole number from 1 to 65535)` };
  const n = Number(text);
  if (n < 1 || n > 65535) return { error: `Not a port: "${text}" (a whole number from 1 to 65535)` };
  return { port: n === DEFAULT_PORT ? undefined : n };
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether `name` (lower-cased) is a DNS host name: dot-separated labels, no scheme/port/path/spaces, not an IP. */
function isHostName(name: string): boolean {
  if (name.length > 253 || isIP(name) !== 0) return false;
  return name.split(".").every((label) => LABEL.test(label));
}

/** The host names in a comma-separated `answer`, trimmed, lower-cased and deduplicated (blank: none), or an
 * error naming every invalid entry. */
export function parseHosts(answer: string): { hosts: string[] } | { error: string } {
  const entries = answer
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  const bad = entries.filter((h) => !isHostName(h));
  if (bad.length > 0) {
    const list = bad.map((h) => `"${h}"`).join(", ");
    return {
      error:
        `Not a host name: ${list}. Enter DNS names only, with no scheme, port, path or spaces ` +
        "(IP addresses are always accepted, so leave them out).",
    };
  }
  return { hosts: [...new Set(entries)] };
}

type Action = "toggle" | "bind" | "port" | "hosts" | "reset" | "done";
const OTHER = Symbol("other");

/**
 * The rerun menu's Web UI section: an overview, then a menu of changes until Done, each saved straight away.
 * Returns whether anything was saved (so the rerun restarts an active service).
 */
export async function webuiStep(ctx: SetupContext, p: Prompter, opts: WebuiStepOptions = {}): Promise<boolean> {
  const e = ctx.extensions.find((x) => x.name === WEBUI);
  if (e === undefined) {
    p.note("The web UI extension isn't installed.");
    return false;
  }
  const interfaces = opts.interfaces ?? networkInterfaces;
  let saved = false;

  const current = (): JsonObject => {
    const extensions = readUserSettings(ctx.home).extensions as Record<string, JsonObject | undefined> | undefined;
    return { ...(extensions?.[WEBUI] ?? {}) };
  };

  /** Applies `change` to `extensions.webui` (undefined removes a key), validates and saves it; false if it
   * changed nothing or didn't validate. */
  const save = (change: Record<string, unknown>): boolean => {
    if (write(ctx, e, change, p)) {
      saved = true;
      return true;
    }
    return false;
  };

  for (;;) {
    const s = current();
    p.box(overview(s, interfaces()), "Web UI");
    const on = isOn(s);
    const action = await p.select<Action>("What would you like to change about the web UI?", [
      on
        ? { label: "Turn off", value: "toggle", hint: "stop serving the web UI" }
        : { label: "Turn on", value: "toggle", hint: "serve the web UI again" },
      { label: "Listen address", value: "bind", hint: "which network the web UI can be reached from" },
      { label: "Port", value: "port" },
      { label: "Host names", value: "hosts", hint: "extra names it answers to, e.g. a VPN or LAN name" },
      { label: "Reset to defaults", value: "reset" },
      { label: "Done", value: "done" },
    ]);

    switch (action) {
      case "done":
        return saved;
      case "toggle":
        save({ enabled: on ? false : undefined });
        break;
      case "bind": {
        const bind = await chooseBind(p, s, interfaces());
        if (bind !== null) save({ bind: bind === DEFAULT_BIND ? undefined : bind });
        break;
      }
      case "port": {
        for (;;) {
          const answer = await p.text("Port the web UI listens on", {
            initial: String(portOf(s)),
            help: `1-65535; blank for the default, ${DEFAULT_PORT}`,
          });
          const parsed = parsePort(answer);
          if ("error" in parsed) {
            p.warn(parsed.error);
            continue;
          }
          save({ port: parsed.port });
          break;
        }
        break;
      }
      case "hosts": {
        for (;;) {
          const answer = await p.text("Extra host names the web UI answers to", {
            initial: hostsOf(s).join(", "),
            help: "comma-separated DNS names, e.g. japa.example.lan; blank for none",
          });
          const parsed = parseHosts(answer);
          if ("error" in parsed) {
            p.warn(parsed.error);
            continue;
          }
          save({ hosts: parsed.hosts.length > 0 ? parsed.hosts : undefined });
          break;
        }
        break;
      }
      case "reset":
        if (await p.confirm("Reset the web UI's on/off, address, port and host names to their defaults?", false)) {
          save({ enabled: undefined, bind: undefined, port: undefined, hosts: undefined });
        }
        break;
    }
  }
}

/** Asks which address to listen on; null for no change (declined the 0.0.0.0 warning). */
async function chooseBind(p: Prompter, s: WebuiSettings, interfaces: Interfaces): Promise<string | null> {
  const currentBind = bindOf(s);
  const choices: Choice<string | typeof OTHER>[] = [
    { label: "This machine only", value: DEFAULT_BIND, hint: `${DEFAULT_BIND}, the default` },
  ];
  for (const a of localAddresses(interfaces)) {
    choices.push({ label: a.address, value: a.address, hint: a.tailscale ? `Tailscale (${a.iface})` : a.iface });
  }
  choices.push({ label: `All addresses (${ALL})`, value: ALL, hint: "every network this machine is on" });
  if (!choices.some((c) => c.value === currentBind)) {
    choices.push({ label: currentBind, value: currentBind, hint: "current" });
  }
  choices.push({ label: "Other…", value: OTHER, hint: "type an IP address" });

  const picked = await p.select<string | typeof OTHER>("Which address should the web UI listen on?", choices, currentBind);
  if (picked === ALL) {
    const ok = await p.confirm(
      "The web UI is plain HTTP (not encrypted): listening on all addresses exposes it to every network this " +
        "machine is on. Only do this on networks you trust. Listen on all addresses?",
      false,
    );
    return ok ? ALL : null;
  }
  if (picked !== OTHER) return picked;
  for (;;) {
    const answer = (await p.text("IP address to listen on", { initial: currentBind })).trim();
    if (isIP(answer) !== 0) return answer;
    p.warn(`Not an IP address: "${answer}"`);
  }
}

/** Writes `change` into `extensions.webui` of the user's settings (keeping its other keys), validated against the
 * extension's schema; true if the file changed. */
function write(ctx: SetupContext, e: JapaExtension, change: Record<string, unknown>, p: Prompter): boolean {
  const user = readUserSettings(ctx.home);
  const extensions = user.extensions as Record<string, JsonObject | undefined> | undefined;
  const before = { ...(extensions?.[WEBUI] ?? {}) };
  const next: JsonObject = { ...before };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete next[key];
    else next[key] = value as JsonObject[string];
  }
  if (JSON.stringify(next) === JSON.stringify(before)) return false;
  let valid: JsonObject;
  try {
    valid = validateExtensionSettings(e.name, settingsSchema(e), next);
  } catch (error) {
    p.warn(`Not saved: ${message(error)}`);
    return false;
  }
  setPath(user, `extensions.${WEBUI}`, valid);
  saveSettings(ctx.home, user);
  return true;
}
