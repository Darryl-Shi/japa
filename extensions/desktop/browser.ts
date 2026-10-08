// The `browser` tool: the desktop's Chromium, driven through its accessibility tree over CDP.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Browser, BrowserContext, Dialog, Page } from "playwright-core";
import { defineTool, Type } from "../../src/sdk.ts";
import type { Desktop } from "./container.ts";
import { isDesktop } from "./env.ts";
import { claimDesktop } from "./lock.ts";

const BROWSER_READS = ["tabs", "snapshot", "text", "screenshot"];
const ACTIONS = [
  ...BROWSER_READS, "navigate", "back", "forward", "reload", "tab_new", "tab_select", "tab_close",
  "click", "hover", "type", "select", "press", "upload", "wait_for", "dialog", "evaluate",
];
// The actions that work while the page has a pending dialog; any other would hang on it.
const PAST_DIALOG = ["dialog", "tabs", "tab_select", "tab_new", "tab_close"];
const DOWNLOADS = "/home/japa/Downloads";

const DESCRIPTION =
  "Drive the desktop's Chromium — the same browser, tabs and logins the user sees — through its accessibility tree. " +
  "Read actions work anywhere: tabs, snapshot { tab? } (elements with refs like e12), text { ref? }, " +
  "screenshot { ref?, fullPage? }. Every other action needs an operator job — from the chief of staff, start one: " +
  "navigate { url }, back, forward, reload, tab_new { url? }, tab_select / tab_close { id }, " +
  "click / hover { ref, button?, count? }, type { ref, text, submit? } (replaces the field's content), " +
  "select { ref, values }, press { key }, upload { ref, paths } (paths on the desktop), " +
  "wait_for { text?, ref?, gone?, timeout? ≤ 30 s }, dialog { accept, text? }, evaluate { js }. " +
  "Refs come from the latest snapshot of a tab; acting actions return the new snapshot, or the lines that changed.";

export const CUT = "[cut at 8,000 tokens]";
const cap = (text: string) => (text.length > 32_000 ? `${text.slice(0, 32_000)}\n${CUT}` : text);
const stale = (ref: string) => `Element ${ref} is gone — take a new snapshot.`;
const unreachable = (reason: string) => `The browser is not reachable: ${reason}`;
const isOpen = (dialog: Dialog) =>
  `A ${dialog.type()} dialog is open: "${dialog.message()}" — answer it with the dialog action.`;
const firstLine = (error: unknown) => (error as Error).message.split("\n")[0]!;
const text = (line: string) => ({ content: [{ type: "text" as const, text: line }] });

export async function snapshotText(page: Page) {
  return cap(`URL: ${page.url()}\nTitle: ${await page.title()}\n${await page.ariaSnapshot({ mode: "ai" })}`);
}

/** The element `ref` names; a ref that matches nothing throws `stale(ref)` at once, not after Playwright's timeout. */
async function byRef(page: Page, ref: string) {
  const locator = page.getByRef(ref);
  if ((await locator.count()) === 0) throw new Error(stale(ref));
  return locator;
}

/** What the tool keeps per page: its id, pending dialog, latest snapshot, and the resolver of the running action's dialog race. */
type Tab = { id: string; dialog?: Dialog; snapshot?: string; race?: (dialog: Dialog) => void };

export function browserTool(desktop: Desktop, connect: () => Promise<Browser>): { tool: ToolRegistration; close(): Promise<void> } {
  let browser: Browser | undefined;
  const tabs = new WeakMap<Page, Tab>();
  let next = 1;
  let current: Page | undefined; // the tab last opened or selected

  const see = (page: Page) => {
    if (tabs.has(page)) return;
    const tab: Tab = { id: String(next++) };
    tabs.set(page, tab);
    page.on("dialog", (dialog) => {
      tab.dialog = dialog;
      tab.race?.(dialog);
    });
  };
  const open = async () => {
    if (!browser?.isConnected()) {
      browser = await connect();
      browser.contexts()[0]!.on("page", see);
    }
    return browser.contexts()[0]!;
  };

  const tool = defineTool({
    name: "browser",
    description: DESCRIPTION,
    executionMode: "sequential",
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      tab: Type.Optional(Type.String()),
      ref: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      button: Type.Optional(StringEnum(["left", "middle", "right"] as const)),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      text: Type.Optional(Type.String()),
      submit: Type.Optional(Type.Boolean()),
      values: Type.Optional(Type.Array(Type.String())),
      key: Type.Optional(Type.String()),
      paths: Type.Optional(Type.Array(Type.String())),
      gone: Type.Optional(Type.Boolean()),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 30 })),
      accept: Type.Optional(Type.Boolean()),
      js: Type.Optional(Type.String()),
      fullPage: Type.Optional(Type.Boolean()),
    }),
    execute: async (args, api, context) => {
      const { action } = args;
      const acting = !BROWSER_READS.includes(action);
      if (acting) {
        const refusal = await claimDesktop(api, context);
        if (refusal) return text(refusal);
      }
      const started = Math.floor(Date.now() / 1000);
      try {
        await desktop.ready(isDesktop(api.env));
      } catch (error) {
        return text((error as Error).message);
      }

      const answer = async () => {
        let chromium: BrowserContext;
        try {
          chromium = await open();
        } catch (error) {
          return unreachable(firstLine(error));
        }
        const pages = () => {
          const all = chromium.pages();
          all.forEach(see);
          return all;
        };
        const currentPage = () => {
          const all = pages();
          return current && all.includes(current) ? current : all.at(-1)!;
        };
        const byId = (id?: string) => {
          const page = pages().find((p) => tabs.get(p)!.id === id);
          if (!page) throw new Error(`There is no tab ${id}.`);
          return page;
        };
        const tabLines = async () => {
          const now = currentPage();
          const lines = pages().map(async (p) => `${tabs.get(p)!.id}${p === now ? " (current)" : ""}: ${await p.title()} — ${p.url()}`);
          return (await Promise.all(lines)).join("\n");
        };

        /** Acts on `page`; a string is the answer, nothing means the page's new snapshot is. */
        const act = async (page: Page, tab: Tab): Promise<string | undefined> => {
          switch (action) {
            case "navigate":
              await page.goto(args.url!);
              await page.bringToFront(); // the keyboard, for the computer tool: from a new tab page it stays in the address bar
              return;
            case "back":
              await page.goBack();
              return;
            case "forward":
              await page.goForward();
              return;
            case "reload":
              await page.reload();
              return;
            case "tab_new":
              current = await chromium.newPage();
              if (args.url) await current.goto(args.url);
              return;
            case "tab_select":
              current = byId(args.id);
              await current.bringToFront();
              return;
            case "tab_close":
              await byId(args.id).close();
              return await tabLines();
            case "click":
              await (await byRef(page, args.ref!)).click({ button: args.button, clickCount: args.count });
              return;
            case "hover":
              await (await byRef(page, args.ref!)).hover();
              return;
            case "type": {
              const field = await byRef(page, args.ref!);
              await field.fill(args.text!);
              if (args.submit) await field.press("Enter");
              return;
            }
            case "select":
              await (await byRef(page, args.ref!)).selectOption(args.values!);
              return;
            case "press":
              await page.keyboard.press(args.key!);
              return;
            case "upload": {
              // Through CDP, since Playwright's setInputFiles reads the files on this host, not on the desktop.
              const input = await byRef(page, args.ref!);
              await input.evaluate((node) => node.setAttribute("data-japa-upload", ""));
              const cdp = await chromium.newCDPSession(page);
              try {
                const { root } = await cdp.send("DOM.getDocument");
                const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-japa-upload]" });
                await cdp.send("DOM.setFileInputFiles", { files: args.paths!, nodeId });
              } finally {
                await input.evaluate((node) => node.removeAttribute("data-japa-upload"));
                await cdp.detach();
              }
              return;
            }
            case "wait_for":
              if (!args.text && !args.ref) return "wait_for needs text or ref";
              await (args.text ? page.getByText(args.text).first() : args.gone ? page.getByRef(args.ref!) : await byRef(page, args.ref!))
                .waitFor({ state: args.gone ? "hidden" : "visible", timeout: (args.timeout ?? 10) * 1000 });
              return;
            case "dialog": {
              const dialog = tab.dialog;
              if (!dialog) return "No dialog is open.";
              tab.dialog = undefined;
              await (args.accept ? dialog.accept(args.text) : dialog.dismiss());
              return;
            }
            case "evaluate":
              return cap(JSON.stringify(await page.evaluate(args.js!)) ?? "undefined");
          }
        };

        try {
          const page = action === "snapshot" && args.tab !== undefined ? byId(args.tab) : currentPage();
          const tab = tabs.get(page)!;
          if (tab.dialog && !PAST_DIALOG.includes(action)) return isOpen(tab.dialog);
          switch (action) {
            case "tabs":
              return await tabLines();
            case "snapshot":
              return (tab.snapshot = await snapshotText(page));
            case "text":
              return cap(await (args.ref ? await byRef(page, args.ref) : page.locator("body")).innerText());
            case "screenshot": {
              const png = args.ref ? await (await byRef(page, args.ref)).screenshot() : await page.screenshot({ fullPage: args.fullPage });
              return {
                content: [
                  { type: "text" as const, text: `URL: ${page.url()}` },
                  { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
                ],
              };
            }
          }

          // The page's next dialog races the action; when it opens first, the action is left to finish once it is answered.
          const raced = await Promise.race([act(page, tab), new Promise<Dialog>((resolve) => (tab.race = resolve))]);
          if (typeof raced === "object") return isOpen(raced);
          if (raced !== undefined) return raced;

          // A dialog open on the resulting tab would stall the snapshot until Playwright's timeout.
          const after = currentPage();
          const kept = tabs.get(after)!;
          if (kept.dialog) return isOpen(kept.dialog);
          const snapshot = await snapshotText(after);
          const previous = kept.snapshot;
          kept.snapshot = snapshot;
          const [url, ...lines] = snapshot.split("\n");
          if (previous === undefined || !previous.startsWith(`${url}\n`)) return snapshot;
          const old = new Set(previous.split("\n"));
          const changed = lines.filter((line) => !old.has(line));
          return `${url}\n${changed.length ? `Changed lines:\n${changed.join("\n")}` : "No change on the page."}`;
        } catch (error) {
          const message = firstLine(error);
          return message === stale(args.ref ?? "") ? message : `${action} failed: ${message}`;
        }
      };

      const result = await answer();
      if (typeof result !== "string") return result;
      if (!acting) return text(result);
      const found = await desktop.exec(
        ["find", DOWNLOADS, "-maxdepth", "1", "-type", "f", "-newermt", `@${started}`, "!", "-name", "*.crdownload"],
      );
      const files = found.stdout.toString().split("\n").filter(Boolean);
      return text(files.length ? `${result}\nDownloaded: ${files.join(", ")}` : result);
    },
  });

  return {
    tool,
    close: async () => {
      if (browser?.isConnected()) await browser.close();
    },
  };
}
