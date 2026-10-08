import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { ACTIVATION_ORDER, CONTRACTS } from "../src/kernel/contracts.ts";
import { REPO_EXTENSIONS, tempHome, testKit, waitFor } from "./helpers.ts";
import { texts, tool } from "./jobs-helpers.ts";
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
