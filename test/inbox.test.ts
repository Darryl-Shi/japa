import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Inbox, NotAllowed } from "../src/channels/inbox.ts";
import type { MainThread } from "../src/pi/harness.ts";
import { SettingsFile } from "../src/settings.ts";

test("the allowlist: no one gets in until listed, only listed users after, and the first is where the agent writes", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "jarvis-"));
	const settings = new SettingsFile(dataDir);
	const asked: string[] = [];
	const thread = { ask: async (requestId: string) => (asked.push(requestId), { text: "hi" }) } as unknown as MainThread;
	const refused: string[] = [];
	const inbox = new Inbox({ platform: "telegram", thread: () => thread, settings, log: (line) => refused.push(line) });
	const target = { chatId: 1, messageId: 1 };

	assert.equal(inbox.admits(42), false, "an empty list lets no one in");
	assert.equal(inbox.owner(), undefined);
	settings.update({ allowlist: { telegram: [42, "77"], whatsapp: ["+15550001"] } });
	assert.equal(inbox.admits(42), true);
	assert.equal(inbox.admits("77"), true);
	assert.equal(inbox.admits(43), false);
	assert.equal(inbox.admits(undefined), false);
	assert.equal(inbox.owner(), "42");
	assert.equal(new Inbox({ platform: "whatsapp", thread: () => thread, settings }).admits(42), false, "lists are per platform");
	assert.deepEqual(await inbox.ask(42, "r1", "hello", target, BACKGROUND_CONTEXT), { text: "hi" });
	await assert.rejects(inbox.ask(43, "r2", "hello", target, BACKGROUND_CONTEXT), NotAllowed, "the thread itself is gated too");
	assert.deepEqual(asked, ["r1"]);
	assert.equal(refused.length, 3);
	await rm(dataDir, { recursive: true, force: true });
});
