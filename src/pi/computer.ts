// The agent's screen: one `computer` tool that sees and drives a backend's desktop like a person would. Generic —
// it uses the backend's native screen API when there is one, otherwise the X display over exec (xdotool, plus
// ImageMagick or ffmpeg for screenshots), so any Linux machine with a display works.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { type Backend, type ScreenAction, shellQuote as q } from "../core/backend.ts";

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

/** The screen as seen over exec. */
class DisplayOverExec {
	private readonly backend: Backend;
	private readonly display: string;
	private geometry: { width: number; height: number } | undefined;

	constructor(backend: Backend, display: string) {
		this.backend = backend;
		this.display = display;
	}

	private async run(command: string, signal?: AbortSignal): Promise<string> {
		let output = "";
		const { exitCode } = await this.backend.exec(command, { env: { DISPLAY: this.display }, onOutput: (chunk) => (output += chunk), ...(signal === undefined ? {} : { signal }) });
		if (exitCode !== 0) throw new Error(output.trim() || `exit ${exitCode}`);
		return output;
	}

	async size(signal?: AbortSignal): Promise<{ width: number; height: number }> {
		if (this.geometry === undefined) {
			const out = await this.run(`xdotool getdisplaygeometry 2>/dev/null || xdpyinfo 2>/dev/null | awk '/dimensions:/{sub("x"," ",$2); print $2}'`, signal);
			const [width, height] = out.trim().split(/\s+/).map(Number);
			if (!width || !height) throw new Error(`No display at ${this.display}`);
			this.geometry = { width, height };
		}
		return this.geometry;
	}

	async screenshot(signal?: AbortSignal): Promise<{ png: string; width: number; height: number; scale: number }> {
		const screen = await this.size(signal);
		const width = Math.min(SHOT_WIDTH, screen.width);
		const height = Math.round((screen.height * width) / screen.width);
		const grab = [
			`if command -v import >/dev/null; then import -window root -resize ${width}x${height}! png:-;`,
			`elif command -v ffmpeg >/dev/null; then ffmpeg -loglevel error -f x11grab -video_size ${screen.width}x${screen.height} -i "$DISPLAY" -frames:v 1 -vf scale=${width}:${height} -f image2pipe -vcodec png -;`,
			`else echo "no screenshot tool: install imagemagick or ffmpeg" >&2; exit 127; fi | base64 -w0`,
		].join(" ");
		return { png: (await this.run(grab, signal)).trim(), width, height, scale: screen.width / width };
	}

	async act(action: ScreenAction, signal?: AbortSignal): Promise<void> {
		await this.run(`command -v xdotool >/dev/null || { echo "xdotool is not installed: install it (e.g. sudo apt-get install -y xdotool)" >&2; exit 127; }; ${xdotoolCommand(action)}`, signal);
	}
}

const actions = ["screenshot", "click", "double_click", "right_click", "move", "drag", "type", "key", "scroll", "share_screen"] as const;

export function computerExtension(options: { backend: Backend; display?: string }): Extension {
	const { backend } = options;
	const display = new DisplayOverExec(backend, options.display ?? ":0");
	/** Screen px per screenshot px, known once a screenshot has been taken. */
	let scale: number | undefined;

	const shoot = async (signal?: AbortSignal) => {
		if (backend.screen !== undefined) {
			const shot = await backend.screen.screenshot(signal);
			scale = 1;
			return { png: Buffer.from(shot.png).toString("base64"), width: shot.width, height: shot.height };
		}
		const shot = await display.screenshot(signal);
		scale = shot.scale;
		return shot;
	};
	const toScreen = (value: number | undefined) => Math.round((value ?? 0) * (scale ?? 1));

	return defineExtension({
		name: "jarvis.computer",
		sections: [
			section(
				"screen",
				() =>
					"Your computer also has a screen. The computer tool shows it (screenshot) and drives it like a person: click, type, key, scroll, drag. Coordinates are pixels in the latest screenshot. Prefer bash for anything scriptable; use the screen for GUIs and websites. share_screen gives a link the user can open to watch or take over, e.g. when a login or 2FA needs them.",
			),
		],
		tools: [
			defineTool({
				name: "computer",
				description: "See and use your computer's screen. Every action except share_screen returns a fresh screenshot.",
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
				execute: async (args, _api, context) => {
					const signal = context.abortSignal;
					if (args.action === "share_screen") {
						if (backend.viewUrl === undefined) throw new Error("This computer has no viewable screen link.");
						return { content: [{ type: "text", text: await backend.viewUrl() }] };
					}
					if (args.action !== "screenshot") {
						if (scale === undefined) await shoot(signal); // establish the coordinate scale
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
						if (backend.screen !== undefined) await backend.screen.act(action, signal);
						else await display.act(action, signal);
						await new Promise((resolve) => setTimeout(resolve, 400)); // let the screen settle
					}
					const shot = await shoot(signal);
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
