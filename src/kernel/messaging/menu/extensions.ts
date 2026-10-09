import type { TSchema } from "@earendil-works/pi-ai";
import type { ExtensionInfo, MessagingContext } from "../../contracts.ts";
import type { Button, Nav, Page } from "./nav.ts";

const LABELS = { on: "✅ on", "not set up": "⚪ not set up", off: "⏸ off" } as const;
const ROLLBACK = "Roll back to last known good";

type Property = TSchema & {
  type?: string;
  enum?: unknown[];
  anyOf?: { const?: unknown }[];
  default?: unknown;
  description?: string;
};

/** `e`'s state label; an error wins. */
const stateLabel = (e: ExtensionInfo) => (e.error !== undefined ? "⚠️ error" : LABELS[e.state]);

/** The settings properties of `e`'s schema the menu shows, all but `enabled`. */
function properties(e: ExtensionInfo): [string, Property][] {
  const all = (e.schema as { properties?: Record<string, Property> } | undefined)?.properties ?? {};
  return Object.entries(all).filter(([prop]) => prop !== "enabled");
}

/** A property's choices: its `enum`, or the `const`s of an `anyOf` of them; undefined when it isn't an enum. */
function choicesOf(schema: Property): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  const consts = schema.anyOf?.map((s) => s.const);
  return consts !== undefined && consts.length > 0 && consts.every((c) => c !== undefined) ? consts : undefined;
}

/** Typed text as a setting's value: its JSON value if it parses, else the text itself. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `e`'s detail: summary, status line, error; its secrets, set or not; its settings' values. */
function detailBody(e: ExtensionInfo): string | undefined {
  const head = [e.summary, e.status, e.error === undefined ? undefined : `Error: ${e.error}`].filter((l) => l);
  const secrets = e.secrets.map((s) => `- ${s.name}: ${s.set ? "set" : "not set"}`);
  const settings = properties(e).map(([prop, schema]) => {
    const value = e.values[prop];
    if (value !== undefined) return `- ${prop}: ${JSON.stringify(value)}`;
    return `- ${prop}: ${schema.default === undefined ? "not set" : `default (${JSON.stringify(schema.default)})`}`;
  });
  const parts = [
    head.join("\n"),
    secrets.length > 0 ? `Secrets:\n${secrets.join("\n")}` : "",
    settings.length > 0 ? `Settings:\n${settings.join("\n")}` : "",
  ].filter((p) => p !== "");
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * The Extensions list and each extension's screen: its secrets typed in (deleted at once), its settings from its
 * schema, turning it off or on, and rolling a workspace one back. `home` is the Settings home.
 */
export function extensionsMenu(nav: Nav, messaging: MessagingContext, home: Page): Page {
  const list: Page = async (outcome) => {
    const items = (await messaging.extensions()).map((e) => [`${e.name} · ${stateLabel(e)}`, detail(e.name)] as const);
    return nav.paged({ title: "Extensions", items, back: home, home, outcome });
  };

  const detail = (name: string): Page => async (outcome) => {
    const e = (await messaging.extensions()).find((x) => x.name === name);
    if (e === undefined) throw new Error(`No extension ${name}.`);
    const self = detail(name);
    const path = (prop: string) => `extensions.${name}.${prop}`;
    const rows: Button[][] = e.secrets.map((s) => {
      const apply = (text: string) => messaging.setSecret(name, s.name, text);
      const title = `Set ${s.name}`;
      const ask = nav.ask({ title, prompt: s.description, secret: true, apply, then: self, cancel: self });
      return [nav.button(title, ask)];
    });
    for (const [prop, schema] of properties(e)) {
      const current = e.values[prop] ?? schema.default;
      const choices = choicesOf(schema);
      if (schema.type === "boolean") {
        const set = () => messaging.setSetting(path(prop), current !== true);
        rows.push([nav.act(`${prop}: ${current === true ? "on" : "off"}`, set, self)]);
      } else if (choices !== undefined) {
        rows.push([nav.button(prop, choose(name, prop, choices, current, self))]);
      } else {
        const apply = (text: string) => messaging.setSetting(path(prop), parsed(text));
        const ask = nav.ask({ title: prop, prompt: schema.description, apply, then: self, cancel: self });
        rows.push([nav.button(prop, ask)]);
      }
    }
    if (e.state === "on") rows.push([nav.act("Turn off", () => messaging.setSetting(path("enabled"), false), self)]);
    if (e.state === "off") rows.push([nav.act("Turn on", () => messaging.setSetting(path("enabled"), undefined), self)]);
    if (e.workspace) {
      const rollback = () => messaging.rollback(name);
      const confirm = nav.confirm(`Roll back ${name} to last known good?`, ROLLBACK, rollback, list, self);
      rows.push([nav.button(ROLLBACK, confirm)]);
    }
    const title = `${name} · ${stateLabel(e)}`;
    return nav.screen({ title, body: detailBody(e), rows, back: list, home, outcome });
  };

  // A setting's choices, the current one ticked; choosing one sets it and goes back to the extension.
  const choose = (name: string, prop: string, choices: unknown[], current: unknown, back: Page): Page =>
    async (outcome) => {
      const items = choices.map((c) => {
        const set = () => messaging.setSetting(`extensions.${name}.${prop}`, c);
        return nav.act(`${c === current ? "✓ " : ""}${String(c)}`, set, back);
      });
      return nav.paged({ title: prop, items, back, home, outcome });
    };

  return list;
}
