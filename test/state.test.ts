import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenItems, WorkingSetFile } from "../src/core/state.ts";

test("open items: promises and questions are never dropped from the projection; old tasks are", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jarvis-state-"));
	const items = new OpenItems(join(dir, "open-items.json"));
	const promise = items.add("promise", "Send Sam the deck by Friday");
	const question = items.add("waiting", "Approve the $29 price?", 42);
	for (let i = 0; i < 40; i++) items.add("task", `research task number ${i} with a reasonably long description`);
	const projection = items.projection() ?? "";
	assert.ok(projection.includes(promise.text) && projection.includes(question.text));
	assert.ok(projection.length <= 2100 && /\(\+\d+ older tasks/.test(projection));
	assert.equal(items.forMessage(42)?.id, question.id);
	items.close(question.id, "approved");
	assert.ok(!(items.projection() ?? "").includes(question.text));
	assert.equal(items.forMessage(42)?.outcome, "approved");
	await rm(dir, { recursive: true, force: true });
});

test("working set: a late summary of an older slice never overwrites a newer one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jarvis-state-"));
	const workingSet = new WorkingSetFile(join(dir, "working-set.json"));
	assert.equal(workingSet.write({ version: 200, text: "newer" }), true);
	assert.equal(workingSet.write({ version: 100, text: "older, finished late" }), false);
	assert.equal(workingSet.read()?.text, "newer");
	await rm(dir, { recursive: true, force: true });
});
