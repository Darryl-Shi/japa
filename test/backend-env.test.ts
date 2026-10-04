// The backend environment must behave like Pi's own local environment: same results, same error codes. Run every
// operation through both on identical directories and compare.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv, Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { LocalBackend } from "../src/backends/local.ts";
import { BackendExecutionEnv } from "../src/pi/backend-env.ts";

const context = BACKGROUND_CONTEXT;

/** Comparable form of a result: the value, or the error's code. */
function shape<T>(result: Result<T, { code: string }>): unknown {
	return result.ok ? { ok: result.value } : { error: result.error.code };
}

async function both(run: (env: ExecutionEnv, root: string) => Promise<unknown>) {
	const nodeRoot = await mkdtemp(join(tmpdir(), "jarvis-node-"));
	const backendRoot = await mkdtemp(join(tmpdir(), "jarvis-backend-"));
	try {
		const expected = await run(new NodeExecutionEnv({ cwd: nodeRoot }), nodeRoot);
		const actual = await run(new BackendExecutionEnv(new LocalBackend(backendRoot)), backendRoot);
		const normalize = (value: unknown, root: string) => JSON.parse(JSON.stringify(value).replaceAll(root, "<root>"));
		assert.deepEqual(normalize(actual, backendRoot), normalize(expected, nodeRoot));
	} finally {
		await rm(nodeRoot, { recursive: true, force: true });
		await rm(backendRoot, { recursive: true, force: true });
	}
}

test("files: write, append, read text/lines/binary, truncate, rename", () =>
	both(async (env) => {
		const binary = new Uint8Array([0, 1, 2, 255, 10, 13, 0]);
		return [
			shape(await env.writeFile("a.txt", "one\ntwo\nthree", context)),
			shape(await env.appendFile("a.txt", "\nfour\n", context)),
			shape(await env.readTextFile("a.txt", context)),
			shape(await env.readTextLines("a.txt", { maxLines: 2 }, context)),
			shape(await env.writeFile("b.bin", binary, context)),
			Array.from((await env.readBinaryFile("b.bin", context)).ok ? ((await env.readBinaryFile("b.bin", context)) as { value: Uint8Array }).value : []),
			shape(await env.truncateFile("a.txt", 3, context)),
			shape(await env.readTextFile("a.txt", context)),
			shape(await env.renameFile("a.txt", "c.txt", context)),
			shape(await env.exists("a.txt", context)),
			shape(await env.exists("c.txt", context)),
			shape(await env.writeFile("quote's \"name\".txt", "", context)),
			shape(await env.writeFile("new/nested/dir/file.txt", "deep", context)),
			shape(await env.appendFile("other/new/log.txt", "line\n", context)),
			shape(await env.readTextFile("new/nested/dir/file.txt", context)),
			shape(await env.readTextFile("quote's \"name\".txt", context)),
		];
	}));

test("files: large content round-trips through chunked transfer", () =>
	both(async (env) => {
		const big = "x".repeat(700_000) + "\nend";
		await env.writeFile("big.txt", big, context);
		const read = await env.readTextFile("big.txt", context);
		return read.ok ? [read.value.length, read.value.slice(-4)] : shape(read);
	}));

test("directories: create, list, info, canonical path, remove", () =>
	both(async (env) => {
		const out: unknown[] = [];
		out.push(shape(await env.createDir("d/e", { recursive: true }, context)));
		out.push(shape(await env.writeFile("d/f.txt", "hi", context)));
		const listed = await env.listDir("d", context);
		out.push(listed.ok ? listed.value.map(({ name, kind, size }) => ({ name, kind, size })).sort((a, b) => a.name.localeCompare(b.name)) : shape(listed));
		const info = await env.fileInfo("d/f.txt", context);
		out.push(info.ok ? { name: info.value.name, kind: info.value.kind, size: info.value.size } : shape(info));
		out.push(shape(await env.canonicalPath("d/e/../f.txt", context)));
		out.push((await env.remove("d/e", undefined, context)).ok);
		out.push(shape(await env.remove("d", { recursive: true }, context)));
		out.push(shape(await env.exists("d", context)));
		return out;
	}));

test("errors map to the same codes", () =>
	both(async (env) => {
		await env.createDir("dir", undefined, context);
		await env.writeFile("file", "x", context);
		return [
			shape(await env.readTextFile("missing", context)),
			shape(await env.readTextFile("dir", context)),
			shape(await env.listDir("missing", context)),
			shape(await env.listDir("file", context)),
			shape(await env.fileInfo("missing", context)),
			shape(await env.remove("missing", undefined, context)),
			shape(await env.remove("missing", { force: true }, context)),
		];
	}));

test("shell: exit codes, cwd, env, streaming, timeouts", () =>
	both(async (env) => {
		const seen: string[] = [];
		const run = await env.exec("echo out; echo err >&2; pwd; echo $GREETING; exit 3", { env: { GREETING: "hello" }, onOutput: (text) => seen.push(text) }, context);
		const timeout = await env.exec("sleep 5", { timeout: 0.2 }, context);
		return [shape(run), seen.join("").split("\n").sort(), shape(timeout)];
	}));

test("shell: output past the spill limits is kept in a file the agent can read", async () => {
	const root = await mkdtemp(join(tmpdir(), "jarvis-backend-"));
	const env = new BackendExecutionEnv(new LocalBackend(root));
	const result = await env.exec("seq 1 5000", { spill: { afterBytes: 1000, afterLines: 100 } }, context);
	assert.ok(result.ok && result.value.spillPath !== undefined);
	const spilled = await env.readTextLines((result as { value: { spillPath: string } }).value.spillPath, undefined, context);
	assert.ok(spilled.ok && spilled.value.length === 5000 && spilled.value.at(-1) === "5000");
	await rm(root, { recursive: true, force: true });
});
