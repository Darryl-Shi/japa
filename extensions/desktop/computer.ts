// The `computer` tool: mouse, keyboard, screenshots and clipboard on the desktop, through docker exec.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { setTimeout as sleep } from "node:timers/promises";
import { defineTool, Type } from "../../src/sdk.ts";
import type { Desktop } from "./container.ts";
import { isDesktop } from "./env.ts";
import { claimDesktop } from "./lock.ts";

const COMPUTER_READS = ["screenshot", "zoom", "cursor_position", "clipboard_get"];
const ACTIONS = [
  ...COMPUTER_READS, "click", "mouse_down", "mouse_up", "move", "drag", "scroll", "type", "key", "wait", "clipboard_set",
];
const BUTTONS: Record<string, number> = { left: 1, middle: 2, right: 3 };
const WHEEL: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };
const XY = ["x", "y"];
const NEEDS: Record<string, string[]> = {
  zoom: ["region"], click: XY, mouse_down: XY, mouse_up: XY, move: XY, drag: ["path"],
  scroll: [...XY, "direction", "amount"], type: ["text"], key: ["combo"], wait: ["seconds"], clipboard_set: ["text"],
};
const SCREEN = ["import", "-window", "root", "png:-"];

const DESCRIPTION =
  "Operate japa's desktop (1280×800 Linux, XFCE) with mouse and keyboard; coordinates are screen pixels. " +
  "Read actions work anywhere: screenshot, zoom { region: [x1, y1, x2, y2] }, cursor_position, clipboard_get. " +
  "Every other action needs an operator job — from the chief of staff, start one: " +
  "click { x, y, button?, count?, modifiers? }, mouse_down / mouse_up { x, y, button? }, move { x, y }, " +
  "drag { path: [[x, y], …] }, scroll { x, y, direction, amount }, type { text }, " +
  "key { combo (xdotool syntax, e.g. ctrl+l, Return), hold? }, wait { seconds ≤ 30 }, clipboard_set { text }. " +
  "Acting actions return a screenshot unless screenshot is false. For web pages, prefer the browser tool.";

const text = (line: string) => ({ content: [{ type: "text" as const, text: line }] });

export function computerTool(desktop: Desktop): ToolRegistration {
  return defineTool({
    name: "computer",
    description: DESCRIPTION,
    executionMode: "sequential",
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      x: Type.Optional(Type.Integer()),
      y: Type.Optional(Type.Integer()),
      region: Type.Optional(Type.Array(Type.Integer(), { minItems: 4, maxItems: 4, description: "[x1, y1, x2, y2]" })),
      button: Type.Optional(StringEnum(["left", "middle", "right"])),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      modifiers: Type.Optional(Type.Array(StringEnum(["ctrl", "shift", "alt", "super"]))),
      path: Type.Optional(
        Type.Array(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 }), { minItems: 2, description: "[[x, y], …]" }),
      ),
      direction: Type.Optional(StringEnum(["up", "down", "left", "right"])),
      amount: Type.Optional(Type.Integer({ minimum: 1 })),
      text: Type.Optional(Type.String()),
      combo: Type.Optional(Type.String()),
      hold: Type.Optional(Type.Number({ minimum: 0, maximum: 30 })),
      seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 30 })),
      screenshot: Type.Optional(Type.Boolean()),
    }),
    execute: async (args, api, context) => {
      const { action, x, y } = args;
      const needs = NEEDS[action] ?? [];
      if (needs.some((name) => args[name as keyof typeof args] === undefined)) {
        return text(`${action} needs ${needs.join(" and ")}`);
      }
      if (!COMPUTER_READS.includes(action)) {
        const refusal = await claimDesktop(api, context);
        if (refusal) return text(refusal);
      }

      /** Runs `argv` in the container; a failure throws the answer. */
      const run = async (argv: string[], input?: string) => {
        const result = await desktop.exec(argv, input);
        if (result.code !== 0) {
          throw new Error(`${action} failed: ${result.stderr.trim().split("\n")[0] || `exit code ${result.code}`}`);
        }
        return result.stdout;
      };
      const xdo = (...argv: unknown[]) => run(["xdotool", ...argv.map(String)]);
      const cursor = async () => {
        const out = (await xdo("getmouselocation", "--shell")).toString();
        return `cursor at ${/X=(\d+)/.exec(out)![1]},${/Y=(\d+)/.exec(out)![1]}`;
      };
      const picture = async (argv: string[]) => {
        const png = await run(argv);
        return {
          content: [
            { type: "text" as const, text: `${action} — ${await cursor()}` },
            { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
          ],
        };
      };

      try {
        await desktop.ready(isDesktop(api.env));
        const button = BUTTONS[args.button ?? "left"];
        switch (action) {
          case "screenshot":
            return await picture(SCREEN);
          case "zoom": {
            const [x1, y1, x2, y2] = args.region!;
            return await picture(["import", "-window", "root", "-crop", `${x2 - x1}x${y2 - y1}+${x1}+${y1}`,
              "+repage", "-resize", "1280x800", "png:-"]);
          }
          case "cursor_position":
            return text(await cursor());
          case "clipboard_get":
            return text((await run(["xclip", "-selection", "clipboard", "-o"])).toString());
          case "wait":
            await sleep(args.seconds! * 1000, undefined, { signal: context.abortSignal });
            return text(`waited ${args.seconds} s`);
          case "click": {
            const modifiers = args.modifiers?.join("+");
            await xdo("mousemove", x, y);
            if (modifiers) await xdo("keydown", modifiers);
            await xdo("click", "--repeat", args.count ?? 1, button);
            if (modifiers) await xdo("keyup", modifiers);
            break;
          }
          case "mouse_down":
          case "mouse_up":
            await xdo("mousemove", x, y);
            await xdo(action === "mouse_down" ? "mousedown" : "mouseup", button);
            break;
          case "move":
            await xdo("mousemove", x, y);
            break;
          case "drag": {
            const [[x0, y0], ...rest] = args.path!;
            await xdo("mousemove", x0, y0);
            await xdo("mousedown", 1);
            for (const [xi, yi] of rest) await xdo("mousemove", xi, yi);
            await xdo("mouseup", 1);
            break;
          }
          case "scroll":
            await xdo("mousemove", x, y);
            await xdo("click", "--repeat", args.amount, WHEEL[args.direction!]);
            break;
          case "type": {
            const chars = [...args.text!]; // by code point, so no chunk splits a character
            for (let i = 0; i < chars.length; i += 50) await xdo("type", "--delay", 12, "--", chars.slice(i, i + 50).join(""));
            break;
          }
          case "key":
            if (args.hold === undefined) await xdo("key", "--", args.combo);
            else {
              await xdo("keydown", "--", args.combo);
              await sleep(args.hold * 1000, undefined, { signal: context.abortSignal });
              await xdo("keyup", "--", args.combo);
            }
            break;
          case "clipboard_set":
            await run(["sh", "-c", "xclip -selection clipboard -i >/dev/null 2>&1"], args.text);
            break;
        }
        await sleep(500, undefined, { signal: context.abortSignal });
        return args.screenshot === false ? text(`${action} — ${await cursor()}`) : await picture(SCREEN);
      } catch (error) {
        return text((error as Error).message);
      }
    },
  });
}
