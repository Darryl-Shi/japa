import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { CONTRACTS, type TriggerContext } from "../src/kernel/contracts.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { REPO_EXTENSIONS, tempHome, testKit, waitFor } from "./helpers.ts";
import { call, say, script } from "./jobs-helpers.ts";
import { bootMessaging, fakeAdapter, sleep } from "./messaging-helpers.ts";

type Fake = ReturnType<typeof fakeAdapter>;

/** Has the CoS answer "send" (or a proactive "[tick] send") with `send_file` of `<home>/outbox/<name>`, then "ok". */
function sending(faux: Parameters<typeof script>[0], home: string, name = "chart.png", caption?: string) {
  const path = join(home, "outbox", name);
  script(faux, (role, text) => {
    if (role === "user" && text.endsWith("send")) return call("send_file", { path, ...(caption && { caption }) });
    if (role === "user") return say(`re: ${text}`);
  });
  return path;
}

/** Writes `<home>/outbox/<name>` with `bytes` bytes. */
function outboxFile(home: string, name = "chart.png", bytes = 3) {
  mkdirSync(join(home, "outbox"), { recursive: true });
  const path = join(home, "outbox", name);
  writeFileSync(path, "");
  truncateSync(path, bytes);
  return path;
}

const sentTexts = (fake: Fake) => fake.sent.map((s) => s.markdown);

test("an adapter with or without sendFile and maxFileBytes validates; wrong types don't", () => {
  const contract = CONTRACTS.get("messaging")!;
  expect(contract.validate(fakeAdapter().adapter)).toBeUndefined();
  expect(contract.validate(fakeAdapter({ files: true, maxFileBytes: 10 }).adapter)).toBeUndefined();
  expect(contract.validate({ ...fakeAdapter().adapter, sendFile: "yes" })).toBe("sendFile must be a function");
  expect(contract.validate({ ...fakeAdapter().adapter, maxFileBytes: "10" })).toBe("maxFileBytes must be a number");
});

test("a sent file goes to the chat through sendFile, its caption with it", async () => {
  const fake = fakeAdapter({ files: true, maxFileBytes: 100 });
  const { daemon, faux, home } = await bootMessaging(fake);
  const path = sending(faux, home, "chart.png", "The **chart**");
  outboxFile(home, "chart.png", 3);
  await fake.receive({ text: "send" });
  await waitFor(() => sentTexts(fake).includes("ok"));
  expect(fake.files).toEqual([
    {
      chat: "42",
      file: { path, name: "chart.png", mimeType: "image/png", size: 3, caption: "The **chart**" },
    },
  ]);
  expect(sentTexts(fake)).toEqual(["ok"]); // the caption goes with the file
  await daemon.close();
});

test("without sendFile, the file is a line naming its path, then its caption", async () => {
  const fake = fakeAdapter();
  const { daemon, faux, home } = await bootMessaging(fake);
  const path = sending(faux, home, "report.pdf", "Q3 numbers");
  outboxFile(home, "report.pdf", 2048);
  await fake.receive({ text: "send" });
  await waitFor(() => sentTexts(fake).includes("ok"));
  expect(sentTexts(fake)).toEqual([`📎 report.pdf (2 KB) is at ${path} on japa's host\n\nQ3 numbers`, "ok"]);
  await daemon.close();
});

test("a file over maxFileBytes is a line naming its path and the adapter's limit", async () => {
  const fake = fakeAdapter({ files: true, maxFileBytes: 1024 });
  const { daemon, faux, home } = await bootMessaging(fake);
  const path = sending(faux, home, "big.zip");
  outboxFile(home, "big.zip", 4096);
  await fake.receive({ text: "send" });
  await waitFor(() => sentTexts(fake).includes("ok"));
  expect(fake.files).toEqual([]);
  expect(sentTexts(fake)).toEqual([
    `📎 big.zip (4 KB) is at ${path} on japa's host (fake can send files up to 1 KB)`,
    "ok",
  ]);
  await daemon.close();
});

test("a sendFile that throws is logged and the file is a line naming its path and the error", async () => {
  const fake = fakeAdapter({ files: true });
  fake.failSendFile = "upload failed";
  const { daemon, faux, home } = await bootMessaging(fake);
  const path = sending(faux, home, "a.txt", "notes");
  outboxFile(home, "a.txt", 5);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await fake.receive({ text: "send" });
  await waitFor(() => sentTexts(fake).includes("ok"));
  expect(sentTexts(fake)).toEqual([
    `📎 a.txt (5 B) is at ${path} on japa's host (couldn't send it: upload failed)\n\nnotes`,
    "ok",
  ]);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("upload failed"));
  errors.mockRestore();
  await daemon.close();
});

test("a file gone by delivery is reported as such", async () => {
  const fake = fakeAdapter({ files: true });
  const { daemon, faux, home } = await bootMessaging(fake);
  const path = outboxFile(home, "gone.png");
  let validated!: () => void;
  const toolDone = new Promise<void>((resolve) => (validated = resolve));
  script(faux, (role, text) => {
    if (role === "user" && text === "send") {
      return fauxAssistantMessage([fauxText("Here."), fauxToolCall("send_file", { path })], { stopReason: "toolUse" });
    }
    if (role === "toolResult") validated();
  });
  // The text before the file is delivered once the tool has validated it; then the file is removed.
  const send = fake.adapter.send;
  fake.adapter.send = async (chat, m) => {
    if (m.markdown === "Here.") {
      await toolDone;
      rmSync(path);
    }
    return send(chat, m);
  };
  await fake.receive({ text: "send" });
  await waitFor(() => sentTexts(fake).includes("ok"));
  expect(fake.files).toEqual([]);
  expect(sentTexts(fake)).toEqual(["Here.", `Couldn't send gone.png: it no longer exists at ${path}.`, "ok"]);
  await daemon.close();
});

/** A `tick` trigger extension; `emit` wakes the CoS with a proactive input. */
function tick() {
  let emit!: TriggerContext["emit"];
  const start = async (c: TriggerContext) => ((emit = c.emit), () => {});
  const extension: JapaExtension = { name: "tick", summary: "Ticks", provides: { trigger: [{ name: "tick", start }] } };
  return { extension, emit: (e: { key: string; text: string }) => emit(e) };
}

test("a file sent in a proactive turn goes to the owner", async () => {
  const fake = fakeAdapter({ files: true });
  const { extension, emit } = tick();
  const { daemon, faux, home } = await bootMessaging(fake, {}, [extension]);
  const path = sending(faux, home);
  outboxFile(home);
  await emit({ key: "k", text: "send" });
  await waitFor(() => fake.files.length === 1);
  expect(fake.files[0]).toMatchObject({ chat: "42", file: { path } });
  await daemon.close();
});

test("a delivered file is not sent again after a restart", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model }, extensions: { fake: { owner: "42" } } }); // sqlite
  sending(kit.faux, home);
  outboxFile(home);
  const fake = fakeAdapter({ files: true });
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake.extension] });
  await fake.receive({ text: "send" });
  await waitFor(() => sentTexts(fake).includes("ok"));
  expect(fake.files).toHaveLength(1);
  await daemon.close();
  const fake2 = fakeAdapter({ files: true });
  const again = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake2.extension] });
  await fake2.receive({ text: "hi", id: "100", messageId: "100" }); // a fresh id: not a replay
  await waitFor(() => sentTexts(fake2).includes("re: hi"));
  await sleep(300);
  expect(fake2.files).toEqual([]);
  expect(sentTexts(fake2)).toEqual(["re: hi"]);
  await again.close();
});

test("a file in flight at the stop is sent after the restart", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model }, extensions: { fake: { owner: "42" } } }); // sqlite
  const path = sending(kit.faux, home);
  outboxFile(home);
  const fake = fakeAdapter({ files: true });
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => (started = resolve));
  let stopping!: () => void;
  const stopped = new Promise<void>((resolve) => (stopping = resolve));
  const start = fake.adapter.start;
  fake.adapter.start = async (c) => {
    const dispose = await start(c);
    return () => {
      stopping();
      return dispose();
    };
  };
  fake.adapter.sendFile = async () => {
    started();
    await stopped;
    throw new Error("aborted");
  };
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake.extension] });
  await fake.receive({ text: "hi" }); // a delivered reply: its cursor is saved
  await waitFor(() => sentTexts(fake).includes("re: hi"));
  await fake.receive({ text: "send" });
  await inFlight;
  await daemon.close();
  const fake2 = fakeAdapter({ files: true });
  const again = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake2.extension] });
  await waitFor(() => fake2.files.length === 1);
  expect(fake2.files[0]).toMatchObject({ chat: "42", file: { path } });
  await waitFor(() => sentTexts(fake2).includes("ok"));
  expect(sentTexts(fake2)).toEqual(["ok"]);
  await again.close();
});
