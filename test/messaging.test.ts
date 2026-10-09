import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { ACTIVATION_ORDER, CONTRACTS, type TriggerContext } from "../src/kernel/contracts.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { interruptedReport, updateReport } from "../src/kernel/messaging/update-report.ts";
import { addSecretRequest, SecretRequestsDoc } from "../src/kernel/secret-requests.ts";
import {
  patchUpdateState,
  readUpdateState,
  type UpdateState,
  updateLog,
  writeUpdateState,
} from "../src/kernel/update-state.ts";
import { bootTest, carryOver, probe, REPO_EXTENSIONS, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, held, say, script, texts, tool } from "./jobs-helpers.ts";
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

/** The prompt for a request for `name` asked "to sync", and the decline message after it. */
const promptText = (name: string) =>
  `japa needs \`${name}\`: to sync. Reply to this message with it; I'll delete your reply at once.`;
const declineText = (name: string) => `Don't want to provide \`${name}\`?`;
const PROMPT = promptText("svc.token");
const DECLINE = declineText("svc.token");
const STALE = "That request is no longer pending.";
const UNDELETED = "Couldn't delete your message — please delete it yourself.";

type Fake = ReturnType<typeof fakeAdapter>;

/** The newest prompt and decline message `fake` was sent for the request for `name`, once both are. */
async function promptOf(fake: Fake, name: string) {
  const find = (markdown: string) => fake.sent.findLast((s) => s.markdown === markdown);
  await waitFor(() => find(declineText(name)) !== undefined);
  return { prompt: find(promptText(name))!, decline: find(declineText(name))! };
}

/** Boots with `fake`, has the CoS ask for `svc.token` on "connect", and waits for its prompt and decline message. */
async function prompted(fake: Fake, extra: JapaExtension[] = []) {
  const booted = await bootMessaging(fake, {}, extra);
  script(booted.faux, (role, text) =>
    role === "user" && text === "connect" ? call("secret_request", { name: "svc.token", why: "to sync" }) : undefined,
  );
  await fake.receive({ text: "connect" });
  return { ...booted, ...(await promptOf(fake, "svc.token")) };
}

const pendingOf = async (daemon: Daemon) =>
  (await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending;
const transcript = async (daemon: Daemon) => JSON.stringify((await daemon.root.entries({}, 500, undefined, ctx)).items);
const sentTexts = (fake: Fake) => fake.sent.map((s) => s.markdown);
const at = (messageId: string) => ({ chat: "42", messageId });

test("each pending request gets a reply prompt with a placeholder, then a Decline message", async () => {
  const fake = fakeAdapter();
  const { daemon, prompt, decline } = await prompted(fake);
  expect(prompt).toMatchObject({ chat: "42", markdown: PROMPT, input: { placeholder: "Paste svc.token" } });
  expect(prompt.buttons).toBeUndefined();
  expect(decline).toMatchObject({ chat: "42", markdown: DECLINE, buttons: [[{ label: "Decline" }]] });
  expect(decline.input).toBeUndefined();
  expect(fake.sent.indexOf(decline)).toBe(fake.sent.indexOf(prompt) + 1);
  await sleep(500);
  expect(sentTexts(fake).filter((t) => t === PROMPT || t === DECLINE)).toEqual([PROMPT, DECLINE]);
  await daemon.close();
});

test("a reply to the prompt fulfils it; reply, prompt and decline message are deleted", async () => {
  const fake = fakeAdapter();
  const { daemon, home, prompt, decline } = await prompted(fake);
  await fake.receive({ text: "s3cr3t", messageId: "77", replyTo: prompt.id });
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
  expect(fake.deleted).toEqual([at("77"), at(prompt.id), at(decline.id)]);
  expect(await pendingOf(daemon)).toEqual([]);
  await waitFor(async () => (await texts(daemon.root, "user")).includes("[secret svc.token provided]"));
  await sleep(300);
  expect(fake.deleted).toHaveLength(3);
  expect(await transcript(daemon)).not.toContain("s3cr3t");
  await daemon.close();
});

test("a reply to the Decline message fulfils the request as a reply to the prompt does", async () => {
  const fake = fakeAdapter();
  const { daemon, home, prompt, decline } = await prompted(fake);
  await fake.receive({ text: "s3cr3t", messageId: "77", replyTo: decline.id });
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
  expect(fake.deleted).toEqual([at("77"), at(prompt.id), at(decline.id)]);
  expect(await pendingOf(daemon)).toEqual([]);
  await waitFor(async () => (await texts(daemon.root, "user")).includes("[secret svc.token provided]"));
  expect(await transcript(daemon)).not.toContain("s3cr3t");
  await daemon.close();
});

test("a plain text while a request is pending goes to the CoS and leaves the request", async () => {
  const fake = fakeAdapter();
  const { daemon } = await prompted(fake);
  await fake.receive({ text: "hello" });
  await waitFor(async () => (await texts(daemon.root, "user")).includes("hello"));
  expect(fake.deleted).toEqual([]);
  expect(await pendingOf(daemon)).toMatchObject([{ name: "svc.token" }]);
  await daemon.close();
});

test("three requests are prompted at once and answered in any order", async () => {
  const fake = fakeAdapter();
  const { daemon, faux, home } = await bootMessaging(fake);
  script(faux, () => undefined);
  const names = ["a.token", "b.token", "c.token"];
  await daemon.root.commit(async (tx) => {
    for (const name of names) await addSecretRequest(tx, name, "to sync");
  }, ctx);
  const [a, b, c] = await Promise.all(names.map((name) => promptOf(fake, name)));
  expect(sentTexts(fake)).toEqual(names.flatMap((name) => [promptText(name), declineText(name)]));
  const order = [c!, a!, b!];
  for (const [i, p] of order.entries()) await fake.receive({ text: `v${i}`, messageId: `7${i}`, replyTo: p.prompt.id });
  expect(names.map((name) => readFileSync(join(home, "secrets", name), "utf8"))).toEqual(["v1", "v2", "v0"]);
  expect(fake.deleted).toEqual(order.flatMap((p, i) => [at(`7${i}`), at(p.prompt.id), at(p.decline.id)]));
  expect(await pendingOf(daemon)).toEqual([]);
  await daemon.close();
});

test("prompts survive a restart: none is sent again, a reply still fulfils and Decline still declines", async () => {
  const kit = testKit();
  script(kit.faux, () => undefined);
  const fake = fakeAdapter();
  const { daemon, home } = await bootMessaging(fake, { storage: { adapter: "sqlite" } }, [], kit);
  await daemon.root.commit(async (tx) => {
    await addSecretRequest(tx, "svc.token", "to sync");
    await addSecretRequest(tx, "other.token", "to sync");
  }, ctx);
  const svc = await promptOf(fake, "svc.token");
  const other = await promptOf(fake, "other.token");
  await daemon.close();
  const fake2 = fakeAdapter();
  const again = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake2.extension] });
  await sleep(500);
  expect(fake2.sent).toEqual([]);
  await fake2.receive({ text: "s3cr3t", messageId: "77", replyTo: svc.prompt.id });
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
  expect(fake2.deleted).toEqual([at("77"), at(svc.prompt.id), at(svc.decline.id)]);
  await fake2.receive({ action: other.decline.buttons![0]![0]!.action, messageId: other.decline.id });
  await waitFor(async () => (await texts(again.root, "user")).includes("[secret other.token declined]"));
  await waitFor(() => fake2.deleted.length === 5);
  expect(fake2.deleted.slice(3)).toEqual([at(other.prompt.id), at(other.decline.id)]);
  expect(sentTexts(fake2).filter((t) => t.startsWith("japa needs"))).toEqual([]);
  await again.close();
});

test("a prompt in flight at the stop is saved first: after a restart none is sent again and a reply fulfils", async () => {
  const kit = testKit();
  script(kit.faux, () => undefined);
  const fake = fakeAdapter();
  const { daemon, home } = await bootMessaging(fake, { storage: { adapter: "sqlite" } }, [], kit);
  fake.slowSends = 300;
  await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
  await waitFor(() => fake.held);
  await daemon.close();
  const prompt = fake.sent.find((s) => s.markdown === PROMPT)!; // delivered, whether or not its send failed
  const fake2 = fakeAdapter();
  const again = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake2.extension] });
  await sleep(500);
  expect(fake2.sent).toEqual([]);
  await fake2.receive({ text: "s3cr3t", messageId: "77", replyTo: prompt.id });
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
  await sleep(2000);
  expect(await transcript(again)).not.toContain("s3cr3t");
  await again.close();
});

test("a message arriving while the stop waits for a send is acknowledged only once the adapter has stopped", async () => {
  const fake = fakeAdapter();
  const { daemon } = await bootMessaging(fake);
  fake.slowSends = 500;
  await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
  await waitFor(() => fake.held);
  const closed = daemon.close();
  await sleep(100);
  let acked: boolean | undefined; // whether the adapter had stopped when the message was acknowledged
  const late = fake.receive({ text: "late" }).then(() => (acked = fake.closed));
  await closed;
  await late;
  expect(acked).toBe(true);
});

test("Decline withdraws the request, tells the CoS, and deletes both messages", async () => {
  const fake = fakeAdapter();
  const { daemon, prompt, decline } = await prompted(fake);
  await fake.press("Decline", decline.id);
  expect(await pendingOf(daemon)).toEqual([]);
  await waitFor(async () => (await texts(daemon.root, "user")).includes("[secret svc.token declined]"));
  await waitFor(() => fake.deleted.length === 2);
  expect(fake.deleted).toEqual([at(prompt.id), at(decline.id)]);
  await fake.press("Decline", decline.id); // pressed again, the request already gone: its message is deleted
  expect(fake.deleted).toEqual([at(prompt.id), at(decline.id), at(decline.id)]);
  await sleep(500);
  expect((await texts(daemon.root, "user")).filter((t) => t === "[secret svc.token declined]")).toHaveLength(1);
  await daemon.close();
});

test("a request fulfilled in japa chat deletes its prompt", async () => {
  const fake = fakeAdapter();
  const { extension, surface } = probe();
  const { daemon, prompt, decline } = await prompted(fake, [extension]);
  await surface().secrets.fulfil((await pendingOf(daemon))[0]!.id, "s3cr3t");
  await waitFor(() => fake.deleted.length === 2);
  expect(fake.deleted).toEqual([at(prompt.id), at(decline.id)]);
  await daemon.close();
});

test("a reply to a prompt no longer pending is deleted, never submitted, and the owner told", async () => {
  const fake = fakeAdapter();
  const { extension, surface } = probe();
  const { daemon, home, prompt } = await prompted(fake, [extension]);
  await surface().secrets.fulfil((await pendingOf(daemon))[0]!.id, "first");
  await waitFor(() => fake.deleted.length === 2);
  const reply = { id: "s", messageId: "77", text: "s3cr3t", replyTo: prompt.id };
  await fake.receive(reply);
  expect(fake.deleted.at(-1)).toEqual(at("77"));
  expect(sentTexts(fake)).toContain(STALE);
  await fake.receive(reply); // delivered again: deleted again, without a second notice
  expect(fake.deleted.slice(2)).toEqual([at("77"), at("77")]);
  await sleep(2000);
  expect(sentTexts(fake).filter((t) => t === STALE)).toHaveLength(1);
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("first");
  expect(await transcript(daemon)).not.toContain("s3cr3t");
  await daemon.close();
});

test("a reply to the Decline message of a request no longer pending is deleted, never submitted, and the owner told", async () => {
  const fake = fakeAdapter();
  const { extension, surface } = probe();
  const { daemon, home, decline } = await prompted(fake, [extension]);
  await surface().secrets.fulfil((await pendingOf(daemon))[0]!.id, "first");
  await waitFor(() => fake.deleted.length === 2);
  await fake.receive({ messageId: "77", text: "s3cr3t", replyTo: decline.id });
  expect(fake.deleted.at(-1)).toEqual(at("77"));
  expect(sentTexts(fake)).toContain(STALE);
  await sleep(2000);
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("first");
  expect(await transcript(daemon)).not.toContain("s3cr3t");
  await daemon.close();
});

test("a reply to a prompt without text asks for text and fulfils nothing", async () => {
  const fake = fakeAdapter();
  const { daemon, prompt } = await prompted(fake);
  await fake.receive({ images: [{ data: PNG, mimeType: "image/png" }], replyTo: prompt.id });
  expect(sentTexts(fake)).toContain("Reply with the secret as text.");
  await sleep(2000);
  expect(await pendingOf(daemon)).toMatchObject([{ name: "svc.token" }]);
  expect(fake.deleted).toEqual([]);
  expect((await texts(daemon.root, "user")).filter((t) => t.includes("[image"))).toEqual([]);
  await daemon.close();
});

test("a reply delivered again is dropped and deleted again", async () => {
  const fake = fakeAdapter();
  const { daemon, prompt } = await prompted(fake);
  const reply = { id: "s", messageId: "77", text: "s3cr3t", replyTo: prompt.id };
  await fake.receive(reply);
  await fake.receive(reply);
  await sleep(2000);
  expect(fake.deleted.filter((d) => d.messageId === "77")).toHaveLength(2);
  expect(sentTexts(fake)).not.toContain(STALE);
  expect(await transcript(daemon)).not.toContain("s3cr3t");
  await daemon.close();
});

test("a reply delivered again is still dropped after japa chat fulfils another request", async () => {
  const fake = fakeAdapter();
  const { extension, surface } = probe();
  const { daemon, prompt } = await prompted(fake, [extension]);
  const reply = { id: "s", messageId: "77", text: "s3cr3t", replyTo: prompt.id };
  await fake.receive(reply);
  await daemon.root.commit((tx) => addSecretRequest(tx, "other.token", "to sync"), ctx);
  await surface().secrets.fulfil((await pendingOf(daemon))[0]!.id, "other");
  await waitFor(async () => (await texts(daemon.root, "user")).includes("[secret other.token provided]"));
  await fake.receive(reply);
  await sleep(2000);
  expect(fake.deleted.filter((d) => d.messageId === "77")).toHaveLength(2);
  expect(sentTexts(fake)).not.toContain(STALE);
  expect(await transcript(daemon)).not.toContain("s3cr3t");
  await daemon.close();
});

test("if the reply can't be deleted, the secret is still stored and the owner told", async () => {
  const fake = fakeAdapter();
  const { daemon, home, prompt } = await prompted(fake);
  fake.failDelete = true;
  await fake.receive({ text: "s3cr3t", replyTo: prompt.id });
  expect(sentTexts(fake)).toContain(UNDELETED);
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
  expect(await pendingOf(daemon)).toEqual([]);
  await daemon.close();
});

test("without an owner nothing is prompted; the owner's first message brings the prompts", async () => {
  const fake = fakeAdapter();
  const { daemon, faux } = await bootMessaging(fake, { extensions: {} });
  await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
  await fake.receive({ user: "7", chat: "7", text: "hi" });
  await sleep(500);
  expect(sentTexts(fake)).toEqual(["Not authorized. Your fake user id is 7."]);
  expect(await tool(daemon, faux, "settings_set", { path: "extensions.fake.owner", value: "42" })).toMatch(/^Set /);
  await sleep(500);
  expect(sentTexts(fake)).not.toContain(PROMPT);
  script(faux, () => undefined);
  await fake.receive({ text: "hello" });
  const { prompt } = await promptOf(fake, "svc.token");
  expect(prompt.chat).toBe("42");
  await waitFor(async () => (await texts(daemon.root, "user")).includes("hello"));
  await daemon.close();
});

test("a prompt whose send fails is retried on the next sync and sent once", async () => {
  const fake = fakeAdapter();
  const { daemon, faux } = await bootMessaging(fake);
  script(faux, () => undefined);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fake.failSend = (m) => m.input !== undefined;
  await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
  await waitFor(() => errors.mock.calls.length > 0);
  expect(errors).toHaveBeenCalledWith("fake: couldn't send a secret prompt: send failed");
  errors.mockRestore();
  expect(fake.sent).toEqual([]);
  fake.failSend = undefined;
  await fake.receive({ text: "hello" });
  await promptOf(fake, "svc.token");
  await sleep(500);
  expect(sentTexts(fake).filter((t) => t === PROMPT)).toHaveLength(1);
  await daemon.close();
});

test("a prompt whose decline message fails to send is deleted; both are sent on the next sync", async () => {
  const fake = fakeAdapter();
  const { daemon, faux, home } = await bootMessaging(fake);
  script(faux, () => undefined);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fake.failSend = (m) => m.buttons !== undefined;
  await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
  await waitFor(() => fake.deleted.length === 1);
  expect(errors).toHaveBeenCalledWith("fake: couldn't send a secret prompt: send failed");
  errors.mockRestore();
  const first = fake.sent.find((s) => s.markdown === PROMPT)!;
  expect(fake.deleted).toEqual([at(first.id)]);
  fake.failSend = undefined;
  await fake.receive({ text: "hello" });
  const { prompt } = await promptOf(fake, "svc.token");
  await sleep(500);
  expect(sentTexts(fake).filter((t) => t === PROMPT || t === DECLINE)).toEqual([PROMPT, PROMPT, DECLINE]);
  await fake.receive({ text: "s3cr3t", messageId: "77", replyTo: prompt.id });
  expect(readFileSync(join(home, "secrets/svc.token"), "utf8")).toBe("s3cr3t");
  await daemon.close();
});

test("a reply to a prompt whose decline message failed, left undeleted, is never submitted", async () => {
  const fake = fakeAdapter();
  const { daemon, faux } = await bootMessaging(fake);
  script(faux, () => undefined);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fake.failSend = (m) => m.buttons !== undefined;
  fake.failDelete = true;
  await daemon.root.commit((tx) => addSecretRequest(tx, "svc.token", "to sync"), ctx);
  await waitFor(() => errors.mock.calls.length > 0);
  errors.mockRestore();
  const orphan = fake.sent.find((s) => s.markdown === PROMPT)!;
  fake.failSend = undefined;
  fake.failDelete = false;
  await fake.receive({ text: "s3cr3t", messageId: "77", replyTo: orphan.id });
  expect(fake.deleted).toContainEqual(at("77"));
  expect(sentTexts(fake)).toContain(STALE);
  await sleep(2000);
  expect(await transcript(daemon)).not.toContain("s3cr3t");
  await daemon.close();
});


describe("update reporting", () => {
  const FROM = "a".repeat(40);
  const TO = "b".repeat(40);
  /** A finished update from FROM to TO asked in chat "7" of `adapter`, unreported; `fields` over that. */
  const updated = (adapter = "fake", fields: Partial<UpdateState> = {}): UpdateState => ({
    state: "updated",
    started: Date.now(),
    finished: Date.now(),
    chat: { adapter, chat: "7" },
    from: FROM,
    to: TO,
    rollback: false,
    restarted: "service",
    commits: ["bbbbbbb two", "ccccccc one"],
    whatsNew: [],
    reported: false,
    ...fields,
  });
  const ROLL_BACK = [[{ label: "Roll back", action: `rb:${FROM}` }]];

  test("a finished update is reported once to the chat that asked, with Roll back", async () => {
    const kit = testKit();
    const { daemon: before, home } = await bootMessaging(fakeAdapter(), {}, [], kit);
    await before.close();
    const whatsNew = ["New extension: demo — Demo pings", "run `japa setup` to configure"];
    writeUpdateState(home, updated("fake", { whatsNew }));
    const fake = fakeAdapter();
    const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, fake.extension] });
    await waitFor(() => fake.sent.length > 0, 1500); // when the surface starts, not at its first poll
    expect(fake.sent).toEqual([
      {
        chat: "7",
        id: "1",
        markdown:
          "✓ Updated aaaaaaa → bbbbbbb\n\nbbbbbbb two\nccccccc one\n\nNew:\nNew extension: demo — Demo pings\n\n" +
          "Configure them in /settings.",
        buttons: ROLL_BACK,
      },
    ]);
    expect(readUpdateState(home)!.reported).toBe(true);
    await sleep(2500);
    expect(fake.sent).toHaveLength(1);
    await daemon.close();
  });

  test("an update report for another adapter is left for it", async () => {
    const fake = fakeAdapter();
    const { daemon, home } = await bootMessaging(fake);
    writeUpdateState(home, updated("telegram"));
    await sleep(2500);
    expect(fake.sent).toEqual([]);
    expect(readUpdateState(home)!.reported).toBe(false);
    await daemon.close();
  });

  test("a result written while running is reported within a few seconds; none once the surface stops", async () => {
    const fake = fakeAdapter();
    const { daemon, home } = await bootMessaging(fake);
    writeUpdateState(home, updated("fake", { state: "running", pid: process.pid, finished: undefined }));
    await sleep(2500);
    expect(fake.sent).toEqual([]);
    patchUpdateState(home, { state: "updated", restarted: "foreground", finished: Date.now() }); // the old daemon reports it
    await waitFor(() => fake.sent.length > 0, 3000);
    expect(fake.sent).toEqual([
      {
        chat: "7",
        id: "1",
        markdown: "✓ Updated aaaaaaa → bbbbbbb\n\nbbbbbbb two\nccccccc one\n\nRestart `japa daemon` to apply.",
        buttons: ROLL_BACK,
      },
    ]);
    await sleep(2500);
    expect(fake.sent).toHaveLength(1);
    await daemon.close();
    writeUpdateState(home, updated());
    await sleep(2500);
    expect(fake.sent).toHaveLength(1);
    expect(readUpdateState(home)!.reported).toBe(false);
  });

  test("an interrupted update is reported to the chat that asked", async () => {
    const fake = fakeAdapter();
    const { daemon, home } = await bootMessaging(fake);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    writeUpdateState(home, updated("fake", { state: "running", pid: dead, finished: undefined }));
    await waitFor(() => fake.sent.length > 0, 3000);
    expect(fake.sent).toEqual([{ chat: "7", id: "1", markdown: `✗ The update was interrupted; see \`${updateLog(home)}\`.` }]);
    expect(readUpdateState(home)!.reported).toBe(true);
    await daemon.close();
  });

  test("a report that can't be sent is sent on a later poll, its error logged once", async () => {
    const fake = fakeAdapter();
    const { daemon, home } = await bootMessaging(fake);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failSend = () => true;
    writeUpdateState(home, updated());
    await sleep(4500);
    expect(errors.mock.calls.filter(([line]) => String(line).includes("update"))).toEqual([
      ["fake: couldn't report the update: send failed"],
    ]);
    errors.mockRestore();
    expect(readUpdateState(home)!.reported).toBe(false);
    fake.failSend = undefined;
    await waitFor(() => fake.sent.length > 0, 3000);
    expect(fake.sent[0]!.markdown).toMatch(/^✓ Updated aaaaaaa → bbbbbbb/);
    expect(readUpdateState(home)!.reported).toBe(true);
    await daemon.close();
  });

  test("a corrupt update.json reports nothing and /update still works", async () => {
    const fake = fakeAdapter();
    const updater = {
      check: async () => ({ current: FROM, target: FROM, commits: [] }),
      current: async () => FROM,
      launch: async () => {},
    };
    const { daemon, home } = await bootMessaging(fake, {}, [], testKit(), { updater });
    writeFileSync(join(home, "update.json"), "{ not json");
    await sleep(2500);
    writeFileSync(join(home, "update.json"), '{ "state": "updated", "chat": { "adapter": "fake", "chat": "7" } }');
    await sleep(2500);
    expect(fake.sent).toEqual([]);
    await fake.receive({ command: "update" });
    expect(fake.edited.at(-1)!.markdown).toBe("✓ japa is up to date (aaaaaaa)");
    await daemon.close();
  });

  test("update reports: a Roll back has no button; restart notes; a failure with its output; up to date", () => {
    const home = "/home/x/.japa";
    expect(updateReport(updated("fake", { rollback: true, commits: [] }), home)).toEqual({
      markdown: "✓ Rolled back aaaaaaa → bbbbbbb",
    });
    expect(updateReport(updated("fake", { restarted: "stopped", commits: [] }), home)).toEqual({
      markdown: "✓ Updated aaaaaaa → bbbbbbb\n\njapa's service is stopped; start it with `japa service start`.",
      buttons: ROLL_BACK,
    });
    const summary = "update failed at validation: node exited with code 1; still on aaaaaaa";
    const failed = updated("fake", { state: "failed", to: undefined, commits: undefined, summary });
    expect(updateReport({ ...failed, output: "SyntaxError: x\n    at y" }, home)).toEqual({
      markdown: `✗ ${summary}\n\n\`\`\`\nSyntaxError: x\n    at y\n\`\`\``,
    });
    expect(updateReport(failed, home)).toEqual({ markdown: `✗ ${summary}` });
    expect(updateReport({ ...failed, summary: undefined }, home)).toEqual({
      markdown: "✗ The update failed; see `/home/x/.japa/logs/update.log`.",
    });
    expect(updateReport(updated("fake", { state: "up to date", to: FROM }), home)).toEqual({
      markdown: "✓ japa is up to date (aaaaaaa)",
    });
    expect(interruptedReport(home)).toEqual({
      markdown: "✗ The update was interrupted; see `/home/x/.japa/logs/update.log`.",
    });
  });
});
