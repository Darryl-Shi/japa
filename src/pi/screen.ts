// The agent's screen: one `computer` tool that sees and drives its computer's desktop like a person would. The X
// display through the call's shell (xdotool, plus ImageMagick or ffmpeg for screenshots), so any Linux machine with a
// display works.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { shellQuote as q } from "../core/shell.ts";
import type { JapaExtension } from "./extension.ts";

export type ScreenAction =
	| { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }
	| { type: "move"; x: number; y: number }
	| { type: "drag"; fromX: number; fromY: number; toX: number; toY: number }
	| { type: "type"; text: string }
	| { type: "key"; keys: string }
	| { type: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; amount?: number };

/** Screenshots are downscaled to this width to save image tokens; coordinates are scaled back. */
const SHOT_WIDTH = 1280;

const BUTTON = { left: 1, middle: 2, right: 3 } as const;
const SCROLL = { up: 4, down: 5, left: 6, right: 7 } as const;

/** The xdotool command for an action, in real screen pixels. Exported for tests. */
export function xdotoolCommand(action: ScreenAction): string {
	switch (action.type) {
		case "click":
			return `xdotool mousemove ${action.x} ${action.y} click ${action.double === true ? "--repeat 2 --delay 80 " : ""}${BUTTON[action.button ?? "left"]}`;
		case "move":
			return `xdotool mousemove ${action.x} ${action.y}`;
		case "drag":
			return `xdotool mousemove ${action.fromX} ${action.fromY} mousedown 1 mousemove ${action.toX} ${action.toY} mouseup 1`;
		case "type":
			return `xdotool type --delay 12 -- ${q(action.text)}`;
		case "key":
			return `xdotool key -- ${action.keys.split(/\s+/).filter(Boolean).map(q).join(" ")}`;
		case "scroll":
			return `xdotool mousemove ${action.x} ${action.y} click --repeat ${action.amount ?? 3} ${SCROLL[action.direction]}`;
	}
}

/** The screen, through a shell on the machine it's on. */
class Display {
	private readonly display: string;
	private geometry: { width: number; height: number } | undefined;

	constructor(display: string) {
		this.display = display;
	}

	private async run(env: ExecutionEnv, command: string, context: Context): Promise<string> {
		let output = "";
		const result = await env.exec(command, { env: { DISPLAY: this.display }, onOutput: (chunk) => void (output += chunk) }, context);
		if (!result.ok) throw result.error;
		if (result.value.exitCode !== 0) throw new Error(output.trim() || `exit ${result.value.exitCode}`);
		return output;
	}

	async size(env: ExecutionEnv, context: Context): Promise<{ width: number; height: number }> {
		if (this.geometry === undefined) {
			const out = await this.run(env, `xdotool getdisplaygeometry 2>/dev/null || xdpyinfo 2>/dev/null | awk '/dimensions:/{sub("x"," ",$2); print $2}'`, context);
			const [width, height] = out.trim().split(/\s+/).map(Number);
			if (!width || !height) throw new Error(`No display at ${this.display}`);
			this.geometry = { width, height };
		}
		return this.geometry;
	}

	async screenshot(env: ExecutionEnv, context: Context): Promise<{ png: string; width: number; height: number; scale: number }> {
		const screen = await this.size(env, context);
		const width = Math.min(SHOT_WIDTH, screen.width);
		const height = Math.round((screen.height * width) / screen.width);
		const grab = [
			`if command -v import >/dev/null; then import -window root -resize ${width}x${height}! png:-;`,
			`elif command -v ffmpeg >/dev/null; then ffmpeg -loglevel error -f x11grab -video_size ${screen.width}x${screen.height} -i "$DISPLAY" -frames:v 1 -vf scale=${width}:${height} -f image2pipe -vcodec png -;`,
			`else echo "no screenshot tool: install imagemagick or ffmpeg" >&2; exit 127; fi | base64 -w0`,
		].join(" ");
		return { png: (await this.run(env, grab, context)).trim(), width, height, scale: screen.width / width };
	}

	async act(env: ExecutionEnv, action: ScreenAction, context: Context): Promise<void> {
		await this.run(env, `command -v xdotool >/dev/null || { echo "xdotool is not installed: install it (e.g. sudo apt-get install -y xdotool)" >&2; exit 127; }; ${xdotoolCommand(action)}`, context);
	}
}

/** The computer a tool call runs on. */
export function computerOf(api: { env: ExecutionEnv | undefined }): ExecutionEnv {
	if (api.env === undefined) throw new Error("There's no computer to run on.");
	return api.env;
}

const actions = ["screenshot", "click", "double_click", "right_click", "move", "drag", "type", "key", "scroll"] as const;

/** The screen's tool and prompt; `display`: the X display to use. */
export function screenTools(options: { display: string }): Extension {
	const screen = new Display(options.display);
	/** Screen px per screenshot px, known once a screenshot has been taken. */
	let scale: number | undefined;

	const shoot = async (env: ExecutionEnv, context: Context) => {
		const shot = await screen.screenshot(env, context);
		scale = shot.scale;
		return shot;
	};
	const toScreen = (value: number | undefined) => Math.round((value ?? 0) * (scale ?? 1));

	return defineExtension({
		name: "screen",
		sections: [
			section(
				"screen",
				() =>
					"Your computer also has a screen. The computer tool shows it (screenshot) and drives it like a person: click, type, key, scroll, drag. Coordinates are pixels in the latest screenshot. Prefer bash for anything scriptable; use the screen for GUIs and websites.",
			),
		],
		tools: [
			defineTool({
				name: "computer",
				description: "See and use your computer's screen. Every action returns a fresh screenshot.",
				parameters: Type.Object({
					action: Type.Union(actions.map((action) => Type.Literal(action))),
					x: Type.Optional(Type.Number()),
					y: Type.Optional(Type.Number()),
					to_x: Type.Optional(Type.Number({ description: "drag target" })),
					to_y: Type.Optional(Type.Number({ description: "drag target" })),
					text: Type.Optional(Type.String({ description: "for type" })),
					keys: Type.Optional(Type.String({ description: 'for key, xdotool names, e.g. "ctrl+l Return"' })),
					direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")])),
					amount: Type.Optional(Type.Number({ description: "scroll steps (default 3)" })),
				}),
				execute: async (args, api, context) => {
					const env = computerOf(api);
					if (args.action !== "screenshot") {
						if (scale === undefined) await shoot(env, context); // establish the coordinate scale
						const at = { x: toScreen(args.x), y: toScreen(args.y) };
						const action: ScreenAction =
							args.action === "click" || args.action === "double_click" || args.action === "right_click"
								? { type: "click", ...at, button: args.action === "right_click" ? "right" : "left", double: args.action === "double_click" }
								: args.action === "move"
									? { type: "move", ...at }
									: args.action === "drag"
										? { type: "drag", fromX: at.x, fromY: at.y, toX: toScreen(args.to_x), toY: toScreen(args.to_y) }
										: args.action === "type"
											? { type: "type", text: args.text ?? "" }
											: args.action === "key"
												? { type: "key", keys: args.keys ?? "" }
												: { type: "scroll", ...at, direction: args.direction ?? "down", ...(args.amount === undefined ? {} : { amount: args.amount }) };
						await screen.act(env, action, context);
						await new Promise((resolve) => setTimeout(resolve, 400)); // let the screen settle
					}
					const shot = await shoot(env, context);
					return {
						content: [
							{ type: "text", text: `Screen (${shot.width}x${shot.height}).` },
							{ type: "image", data: shot.png, mimeType: "image/png" },
						],
					};
				},
			}),
		],
	});
}

/** The screen, on by default when the machine has a display. */
export function screenExtension(options: { display: string; hasDisplay: boolean }): JapaExtension {
	return { ...screenTools(options), title: "Screen", about: "Seeing and using the machine's desktop.", enabledByDefault: options.hasDisplay };
}
