import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { screenExtension, xdotoolCommand } from "../src/pi/screen.ts";
import { agent, call, say } from "./helpers.ts";

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
	const commands: string[] = [];
	let clicked = false;
	const h = await agent({
		extensions: {
			// The screen as it is, with every command it runs on the machine recorded on the way.
			screen: (pi) => screenExtension({ display: ":97", hasDisplay: true })({ ...pi, exec: (command, args, options) => (commands.push(args.join(" ")), pi.exec(command, args, options)) }),
		},
		script: (turn) => {
			if (turn.text.includes("look at the screen")) return call("computer", { action: "screenshot" });
			if (turn.text.startsWith("Screen (") && !clicked) {
				clicked = true;
				return call("computer", { action: "click", x: 640, y: 360 });
			}
			return say("Looked.");
		},
	});
	try {
		await h.ask("1", "look at the screen");
		const results = (await h.thread.root.context(context)).messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		const image = results[0]?.content.find((part) => part.type === "image");
		assert.ok(image !== undefined && image.type === "image", "the screenshot came back as an image");
		assert.deepEqual(pngSize(image.data), { width: 1280, height: 720 });
		// This machine has no xdotool: the click fails with an instruction the agent can act on, on its own machine.
		const click = results[1]?.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		assert.match(click ?? "", /xdotool is not installed/);
		assert.ok(commands.some((command) => command.includes("xdotool mousemove 960 540 click 1")), "640,360 in the 1280-wide shot is 960,540 on the 1920-wide screen");
	} finally {
		await h.done();
		xvfb?.kill();
	}
});
