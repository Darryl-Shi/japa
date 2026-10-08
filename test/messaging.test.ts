import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { ACTIVATION_ORDER, CONTRACTS, type TriggerContext } from "../src/kernel/contracts.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { bootTest, carryOver, REPO_EXTENSIONS, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, held, say, script, texts, tool } from "./jobs-helpers.ts";
import { bootMessaging, fakeAdapter, sleep } from "./messaging-helpers.ts";

test("the messaging contract validates adapters and activates after surfaces", () => {
  expect(ACTIVATION_ORDER).toEqual(["provider", "environment", "tool", "trigger", "surface", "messaging"]);
  const contract = CONTRACTS.get("messaging")!;
  expect(contract.validate(fakeAdapter().adapter)).toBeUndefined();
  expect(contract.validate({ ...fakeAdapter().adapter, send: undefined })).toBe("send must be a function");
  expect(contract.validate({ ...fakeAdapter().adapter, maxMessageChars: "4096" })).toBe(
    "maxMessageChars must be a number",
  );
});

test("an adapter not named after its extension is an activation error", async () => {
  let started = false;
  const adapter = { ...fakeAdapter({ name: "other" }).adapter, start: async () => ((started = true), () => {}) };
  const { daemon } = await bootTest({}, [{ name: "chat", summary: "Chat", provides: { messaging: [adapter] } }]);
  expect(daemon.status().errors).toContainEqual({ name: "chat", error: 'messaging: name must be "chat"' });
  expect(started).toBe(false);
  await daemon.close();
});

test("anyone but the owner gets their user id and goes no further", async () => {
  const fake = fakeAdapter();
  const { daemon } = await bootMessaging(fake, { extensions: {} }); // no owner yet
  await fake.receive({ user: "7", chat: "7", text: "hi" });
  expect(fake.sent).toMatchObject([{ chat: "7", markdown: "Not authorized. Your fake user id is 7." }]);
  await sleep(2000);
  expect(await texts(daemon.root, "user")).toEqual([]);
  await daemon.close();
});

test("an owner id given as a number authorizes that user", async () => {
  const fake = fakeAdapter();
  const { daemon, faux, home } = await bootMessaging(fake, { extensions: {} });
  expect(await tool(daemon, faux, "settings_set", { path: "extensions.fake.owner", value: 42 })).toMatch(/^Set /);
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).extensions.fake.owner).toBe("42");
  await fake.receive({ text: "hi" });
  await waitFor(async () => (await texts(daemon.root, "user")).includes("hi"));
  expect(await tool(daemon, faux, "settings_set", { path: "extensions.fake.owner", value: {} })).toMatch(
    /^Not changed: .*owner/,
  );
  await daemon.close();
});

test("the owner's messages within 1.5 s are one input with the surface's origin", async () => {
  const fake = fakeAdapter();
  const { daemon } = await bootMessaging(fake);
  await fake.receive({ id: "11", text: "part one" });
  await sleep(300);
  await fake.receive({ id: "12", text: "part two" });
  await waitFor(async () => (await texts(daemon.root, "user")).includes("part one\n\npart two"));
  expect(
    await daemon.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "surface:fake:42:11"), ctx),
  ).toBeDefined();
  await sleep(2000);
  await fake.receive({ text: "later" });
  await waitFor(async () => (await texts(daemon.root, "user")).includes("later"));
  await daemon.close();
});

test("a replayed message is admitted once, inside the window and after it", async () => {
  const fake = fakeAdapter();
  const { daemon } = await bootMessaging(fake);
  await fake.receive({ id: "9", text: "x" });
  await fake.receive({ id: "9", text: "x" });
  await sleep(2000);
  await fake.receive({ id: "9", text: "x" });
  await sleep(2000);
  expect((await texts(daemon.root, "user")).filter((t) => t.startsWith("x"))).toEqual(["x"]);
  await daemon.close();
});

test("a message still in the merge window is submitted when the daemon stops", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model }, extensions: { fake: { owner: "42" } } }); // sqlite
  const fake = fakeAdapter();
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake.extension] });
  await fake.receive({ text: "bye" });
  await daemon.close();
  const again = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fakeAdapter().extension] });
  await waitFor(async () => (await texts(again.root, "user")).includes("bye"));
  await again.close();
});

const PNG = new Uint8Array([137, 80, 78, 71]);
const day = () => new Date().toISOString().slice(0, 10);

/** The content of the root's newest user entry, once there is one. */
async function userContent(daemon: Daemon) {
  let content: unknown;
  await waitFor(async () => {
    const entries = (await daemon.root.entries({}, 200, undefined, ctx)).items;
    content = entries.find((e) => e.kind === "pi.user")?.model?.[0]?.content;
    return content !== undefined;
  });
  return content;
}

test("an image is saved under attachments and sent as an image part with its path", async () => {
  const fake = fakeAdapter();
  const { daemon, faux, home } = await bootMessaging(fake);
  script(faux, () => undefined);
  await fake.receive({ id: "31", text: "look", images: [{ data: PNG, mimeType: "image/png" }] });
  const path = join(home, "attachments", day(), "31.png");
  await waitFor(() => existsSync(path));
  expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
  expect(await userContent(daemon)).toEqual([
    { type: "text", text: `look\n[image saved to ${path}]` },
    { type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
  ]);
  expect(await carryOver(daemon)).toContain(`[image saved to ${path}]`);
  await daemon.close();
});

test("an album inside the window is one input with every image", async () => {
  const fake = fakeAdapter();
  const { daemon, home } = await bootMessaging(fake);
  await fake.receive({ id: "41", images: [{ data: PNG, mimeType: "image/jpeg" }] });
  await sleep(200);
  await fake.receive({ id: "42", images: [{ data: PNG, mimeType: "image/jpeg" }] });
  const [p41, p42] = ["41", "42"].map((id) => join(home, "attachments", day(), `${id}.jpg`));
  expect(await userContent(daemon)).toMatchObject([
    { type: "text", text: `[image saved to ${p41}]\n[image saved to ${p42}]` },
    { type: "image" },
    { type: "image" },
  ]);
  await daemon.close();
});

test("a model without image input gets only the path notes", async () => {
  const fake = fakeAdapter();
  const kit = testKit({ models: [{ id: "blind", input: ["text"] }] });
  const { daemon, home } = await bootMessaging(fake, {}, [], kit);
  await fake.receive({ id: "51", text: "look", images: [{ data: PNG, mimeType: "image/png" }] });
  const path = join(home, "attachments", day(), "51.png");
  expect(await userContent(daemon)).toBe(`look\n[image saved to ${path}]\n(this model cannot see images)`);
  await daemon.close();
});

test("an image that cannot be saved still lets the text through, with a note", async () => {
  const fake = fakeAdapter();
  const { daemon, home } = await bootMessaging(fake);
  writeFileSync(join(home, "attachments"), "not a dir");
  await fake.receive({ id: "61", text: "look", images: [{ data: PNG, mimeType: "image/png" }] });
  const content = (await userContent(daemon)) as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0].text).toMatch(/^look\n\[image could not be saved: .+\]$/);
  await daemon.close();
});

/** A `tick` trigger extension; `emit` wakes the CoS with a proactive input. */
function tick() {
  let emit!: TriggerContext["emit"];
  const start = async (c: TriggerContext) => ((emit = c.emit), () => {});
  const extension: JapaExtension = { name: "tick", summary: "Ticks", provides: { trigger: [{ name: "tick", start }] } };
  return { extension, emit: (e: { key: string; text: string }) => emit(e) };
}

const echo = (role: string, text: string) => (role === "user" ? say(`re: ${text}`) : undefined);

test("the owner's replies and proactive replies are sent; japa chat's are not", async () => {
  const fake = fakeAdapter();
  const { extension, emit } = tick();
  const { daemon, faux } = await bootMessaging(fake, {}, [extension]);
  script(faux, echo);
  await fake.receive({ text: "hi" });
  await waitFor(() => fake.sent.some((s) => s.markdown === "re: hi"));
  await ask(daemon, "from the terminal");
  await emit({ key: "k", text: "tick" });
  await waitFor(() => fake.sent.some((s) => s.markdown === "re: [tick] tick"));
  expect(fake.sent.map((s) => [s.chat, s.markdown])).toEqual([["42", "re: hi"], ["42", "re: [tick] tick"]]);
  await daemon.close();
});

test("a long reply is sent in parts", async () => {
  const fake = fakeAdapter({ maxMessageChars: 20 });
  const { daemon, faux } = await bootMessaging(fake);
  script(faux, (role) => (role === "user" ? say("first paragraph\n\nsecond paragraph") : undefined));
  await fake.receive({ text: "hi" });
  await waitFor(() => fake.sent.length === 2);
  expect(fake.sent.map((s) => s.markdown)).toEqual(["first paragraph", "second paragraph"]);
  await daemon.close();
});

test("typing shows every 4 s while the owner's run is going, and not for japa chat's", { timeout: 20_000 }, async () => {
  const fake = fakeAdapter();
  const { daemon, faux } = await bootMessaging(fake);
  const owner = held(), terminal = held();
  script(faux, (role, text, signal) => {
    if (text === "hi") return owner.wait(say("ok"), signal);
    if (text === "from the terminal") return terminal.wait(say("done"), signal);
  });
  await fake.receive({ text: "hi" });
  await waitFor(() => owner.started());
  await sleep(4500);
  expect(fake.typing.filter((c) => c === "42").length).toBeGreaterThanOrEqual(2);
  owner.release();
  await waitFor(() => fake.sent.some((s) => s.markdown === "ok"));
  await daemon.root.waitForIdle(ctx);
  const typed = fake.typing.length;
  await daemon.root.submit({ type: "input", content: "from the terminal" }, ctx);
  await waitFor(() => terminal.started());
  await sleep(4500);
  expect(fake.typing.length).toBe(typed);
  terminal.release();
  await daemon.root.waitForIdle(ctx);
  await daemon.close();
});

test("a reply that fails to send is logged and skipped", async () => {
  const fake = fakeAdapter();
  const { daemon, faux } = await bootMessaging(fake);
  script(faux, echo);
  fake.failSend = (m) => m.markdown === "re: bad";
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await fake.receive({ text: "bad" });
  await sleep(2000);
  await fake.receive({ text: "good" });
  await waitFor(() => fake.sent.some((s) => s.markdown === "re: good"));
  expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^fake: couldn't send a reply: /));
  expect(fake.sent.map((s) => s.markdown)).toEqual(["re: good"]);
  errors.mockRestore();
  await daemon.close();
});

test("a reply in flight at the stop is sent after the restart, and a sent one is not sent again", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model }, extensions: { fake: { owner: "42" } } }); // sqlite
  script(kit.faux, echo);
  const fake = fakeAdapter();
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake.extension] });
  await fake.receive({ text: "one" });
  await waitFor(() => fake.sent.some((s) => s.markdown === "re: one"));
  fake.holdSends = true;
  await fake.receive({ text: "two" });
  await waitFor(() => fake.held);
  await daemon.close();
  const fake2 = fakeAdapter();
  const again = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake2.extension] });
  await waitFor(() => fake2.sent.length > 0);
  await sleep(500);
  expect(fake2.sent.map((s) => s.markdown)).toEqual(["re: two"]);
  await again.close();
});
