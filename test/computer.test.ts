import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ShellExecOptions } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { computerExtension, xdotoolCommand } from "../src/pi/computer.ts";
import { MainThread } from "../src/pi/harness.ts";
import { DEFAULTS } from "../src/settings.ts";

const context = BACKGROUND_CONTEXT;

test("screen actions become xdotool commands in screen pixels", () => {
	assert.equal(xdotoolCommand({ type: "click", x: 10, y: 20 }), "xdotool mousemove 10 20 click 1");
	assert.equal(xdotoolCommand({ type: "click", x: 1, y: 2, button: "right" }), "xdotool mousemove 1 2 click 3");
	assert.equal(xdotoolCommand({ type: "click", x: 1, y: 2, double: true }), "xdotool mousemove 1 2 click --repeat 2 --delay 80 1");
	assert.equal(xdotoolCommand({ type: "type", text: "it's done" }), "xdotool type --delay 12 -- 'it'\\''s done'");
	assert.equal(xdotoolCommand({ type: "key", keys: "ctrl+l  Return" }), "xdotool key -- 'ctrl+l' 'Return'");
	assert.equal(xdotoolCommand({ type: "scroll", x: 5, y: 6, direction: "down" }), "xdotool mousemove 5 6 click --repeat 3 5");
	assert.equal(xdotoolCommand({ type: "drag", fromX: 1, fromY: 2, toX: 3, toY: 4 }), "xdotool mousemove 1 2 mousedown 1 mousemove 3 4 mouseup 1");
});

function pngSize(base64: string): { width: number; height: number } {
	const bytes = Buffer.from(base64, "base64");
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("the agent sees a real X display through its computer tool, downscaled, with clicks scaled back", async (t) => {
	let xvfb: ChildProcess | undefined;
	try {
		xvfb = spawn("Xvfb", [":97", "-screen", "0", "1920x1080x24"], { stdio: "ignore" });
		await new Promise((resolve) => setTimeout(resolve, 800));
	} catch {
		t.skip("Xvfb not available");
		return;
	}
	const dataDir = await mkdtemp(join(tmpdir(), "japa-"));
	await mkdir(join(dataDir, "machine"));
	const commands: string[] = [];
	// Its computer, with every command it runs recorded.
	const computer = new (class extends NodeExecutionEnv {
		override exec(command: string, options: ShellExecOptions | undefined, callContext: Context) {
			commands.push(command);
			return super.exec(command, options, callContext);
		}
	})({ cwd: join(dataDir, "machine") });
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("computer", { action: "screenshot" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("computer", { action: "click", x: 640, y: 360 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Looked."),
	]);
	const settings = () => ({ ...DEFAULTS, model: { provider: "faux", modelId: "faux-1" } });
	const thread = await MainThread.open({ dataDir, models, settings, installed: [computerExtension({ display: ":97" })], env: () => computer }, context);
	try {
		await thread.ask("1", "look at the screen", { channel: "test", chatId: "1", messageId: "1" }, context);
		const results = (await thread.root.context(context)).messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		const image = results[0]?.content.find((part) => part.type === "image");
		assert.ok(image !== undefined && image.type === "image", "the screenshot came back as an image");
		assert.deepEqual(pngSize(image.data), { width: 1280, height: 720 });
		// This machine has no xdotool: the click fails with an instruction the agent can act on, on its own machine.
		const click = results[1]?.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		assert.match(click ?? "", /xdotool is not installed/);
		assert.ok(commands.some((command) => command.includes("xdotool mousemove 960 540 click 1")), "640,360 in the 1280-wide shot is 960,540 on the 1920-wide screen");
	} finally {
		await thread.close(context);
		xvfb?.kill();
		await rm(dataDir, { recursive: true, force: true });
	}
});
