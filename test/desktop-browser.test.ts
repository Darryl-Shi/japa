import { type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Browser, Page } from "playwright-core";
import { beforeEach, expect, test, vi } from "vitest";
import { browserTool, CUT, snapshotText } from "../extensions/desktop/browser.ts";
import { OPERATOR } from "../extensions/desktop/lock.ts";
import { fakeApi, fakeBrowser, fakeDesktop, fakeLocator, fakePage, resultText, run } from "./desktop-helpers.ts";

let fake: ReturnType<typeof fakeDesktop>;
let api: ToolExecutionApi;
const browse = (...pages: ReturnType<typeof fakePage>[]) => {
  const browser = fakeBrowser(pages);
  return { browser, ...browserTool(fake.desktop, async () => browser as unknown as Browser) };
};
beforeEach(() => {
  fake = fakeDesktop();
  api = fakeApi().api;
});

test("a snapshot is capped at 8,000 tokens with a note", async () => {
  const text = await snapshotText(fakePage({ snapshots: ["- x\n".repeat(20_000)] }) as unknown as Page);
  expect(text.length).toBe(32_000 + 1 + CUT.length);
  expect(text.startsWith("URL: https://example.com/\nTitle: Example\n- x")).toBe(true);
  expect(text.endsWith(`\n${CUT}`)).toBe(true);
});

test("a stale ref answers at once", async () => {
  const page = fakePage();
  const { tool } = browserTool(fakeDesktop().desktop, async () => fakeBrowser([page]) as unknown as Browser);
  const started = Date.now();
  expect(resultText(await run(tool, { action: "click", ref: "e12" }, fakeApi().api))).toBe("Element e12 is gone — take a new snapshot.");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("read actions work outside the desktop environment; acting ones are refused there", async () => {
  const { tool } = browse(fakePage());
  const { api } = fakeApi({ desktop: false });
  expect(resultText(await run(tool, { action: "tabs" }, api))).toBe("1 (current): Example — https://example.com/");
  expect(resultText(await run(tool, { action: "snapshot" }, api))).toBe('URL: https://example.com/\nTitle: Example\n- heading "Example" [ref=e1]');
  expect(resultText(await run(tool, { action: "navigate", url: "https://x.test/" }, api))).toBe(OPERATOR);
  expect(fake.waits).toEqual([false, false]);
});

test("after an action on the same page, only the changed lines come back", async () => {
  const { tool } = browse(fakePage({ snapshots: ["- a [ref=e1]\n- b", "- a [ref=e1]\n- c"], refs: { e1: fakeLocator() } }));
  await run(tool, { action: "snapshot" }, api);
  const clicked = await run(tool, { action: "click", ref: "e1" }, api);
  expect(resultText(clicked)).toBe("URL: https://example.com/\nChanged lines:\n- c");
  expect(resultText(await run(tool, { action: "click", ref: "e1" }, api))).toBe("URL: https://example.com/\nNo change on the page.");
  expect(resultText(await run(tool, { action: "navigate", url: "https://x.test/" }, api)))
    .toBe("URL: https://x.test/\nTitle: Example\n- a [ref=e1]\n- c");
});

test("a dialog opened by an action is reported, and answered with dialog", async () => {
  const dialog = { type: () => "confirm", message: () => "Sure?", accept: vi.fn(async () => {}), dismiss: vi.fn() };
  const page = fakePage({ refs: { e1: fakeLocator({ click: () => { page.emit("dialog", dialog); return new Promise(() => {}); } }) } });
  const { tool } = browse(page);
  const open = 'A confirm dialog is open: "Sure?" — answer it with the dialog action.';
  expect(resultText(await run(tool, { action: "click", ref: "e1" }, api))).toBe(open);
  expect(resultText(await run(tool, { action: "snapshot" }, api))).toBe(open);
  await run(tool, { action: "dialog", accept: true }, api);
  expect(dialog.accept).toHaveBeenCalled();
  expect(resultText(await run(tool, { action: "snapshot" }, api))).toMatch(/^URL: https:\/\/example\.com\//);
  expect(resultText(await run(tool, { action: "dialog", accept: true }, api))).toMatch(/^No dialog is open\./);
});

test("a dialog already open on the tab an action lands on is reported instead of a snapshot", async () => {
  const dialog = { type: () => "alert", message: () => "Hi", accept: vi.fn(async () => {}), dismiss: vi.fn() };
  const first = fakePage();
  const { tool } = browse(first, fakePage());
  await run(tool, { action: "tabs" }, api);
  first.emit("dialog", dialog);
  expect(resultText(await run(tool, { action: "tab_select", id: "1" }, api))).toBe('A alert dialog is open: "Hi" — answer it with the dialog action.');
});

test("wait_for never waits without a timeout, and a stale ref answers at once", async () => {
  const { tool } = browse(fakePage());
  const call = (args: object) => ({ type: "toolCall" as const, id: "", name: "browser", arguments: { action: "wait_for", text: "x", ...args } });
  expect(() => validateToolArguments(tool as unknown as Tool, call({ timeout: 0 }))).toThrow(/timeout/);
  expect(validateToolArguments(tool as unknown as Tool, call({ timeout: 1 })).timeout).toBe(1);
  expect(resultText(await run(tool, { action: "wait_for", ref: "e12" }, api))).toBe("Element e12 is gone — take a new snapshot.");
});

test("an unreachable browser answers with the reason", async () => {
  const { tool } = browserTool(fakeDesktop().desktop, async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9222\nCall log: …"); });
  expect(resultText(await run(tool, { action: "tabs" }, fakeApi().api))).toBe("The browser is not reachable: connect ECONNREFUSED 127.0.0.1:9222");
});

test("downloads finished during an action are listed", async () => {
  const { tool } = browse(fakePage());
  fake.reply((argv) => argv[0] === "find", { stdout: Buffer.from("/home/japa/Downloads/bill.pdf\n") });
  expect(resultText(await run(tool, { action: "navigate", url: "https://example.com/bill" }, api))).toMatch(/\nDownloaded: \/home\/japa\/Downloads\/bill\.pdf$/);
  expect(fake.calls.at(-1)!.argv).toEqual(["find", "/home/japa/Downloads", "-maxdepth", "1", "-type", "f", "-newermt",
    expect.stringMatching(/^@\d+$/), "!", "-name", "*.crdownload"]);
});

test("acting actions drive the page, its elements and its tabs", async () => {
  const e1 = fakeLocator();
  const page = fakePage({ refs: { e1 } });
  const { tool, browser, close } = browse(page);
  await run(tool, { action: "click", ref: "e1", button: "right", count: 2 }, api);
  await run(tool, { action: "type", ref: "e1", text: "hi", submit: true }, api);
  await run(tool, { action: "select", ref: "e1", values: ["a"] }, api);
  await run(tool, { action: "press", key: "Tab" }, api);
  expect(e1.click).toHaveBeenCalledWith({ button: "right", clickCount: 2 });
  expect(e1.fill).toHaveBeenCalledWith("hi");
  expect(e1.press).toHaveBeenCalledWith("Enter");
  expect(e1.selectOption).toHaveBeenCalledWith(["a"]);
  expect(page.keyboard.press).toHaveBeenCalledWith("Tab");
  expect(resultText(await run(tool, { action: "evaluate", js: "1 + 1" }, api))).toBe('{"ran":"1 + 1"}');
  await run(tool, { action: "tab_new", url: "https://x.test/" }, api);
  expect(resultText(await run(tool, { action: "tabs" }, api))).toBe("1: Example — https://example.com/\n2 (current): Example — https://x.test/");
  await run(tool, { action: "tab_select", id: "1" }, api);
  expect(page.bringToFront).toHaveBeenCalled();
  expect(resultText(await run(tool, { action: "tabs" }, api))).toBe("1 (current): Example — https://example.com/\n2: Example — https://x.test/");
  await close();
  expect(browser.close).toHaveBeenCalled();
});
