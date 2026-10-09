import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { beforeEach, expect, test, vi } from "vitest";
import { computerTool } from "../extensions/desktop/computer.ts";
import { claimDesktop, COS } from "../extensions/desktop/lock.ts";
import { fakeApi, fakeDesktop, PNG, resultText, run } from "./desktop-helpers.ts";

const SHOT = [["import", "-window", "root", "png:-"], ["xdotool", "getmouselocation", "--shell"]];

let fake: ReturnType<typeof fakeDesktop>;
let tool: ToolRegistration;
beforeEach(() => {
  fake = fakeDesktop();
  tool = computerTool(fake.desktop);
});

test.each([
  [{ action: "click", x: 10, y: 20 }, [["xdotool", "mousemove", "10", "20"], ["xdotool", "click", "--repeat", "1", "1"]]],
  [{ action: "click", x: 10, y: 20, button: "right", count: 2, modifiers: ["ctrl", "shift"] },
    [["xdotool", "mousemove", "10", "20"], ["xdotool", "keydown", "ctrl+shift"], ["xdotool", "click", "--repeat", "2", "3"], ["xdotool", "keyup", "ctrl+shift"]]],
  [{ action: "mouse_down", x: 1, y: 2, button: "middle" }, [["xdotool", "mousemove", "1", "2"], ["xdotool", "mousedown", "2"]]],
  [{ action: "mouse_up", x: 1, y: 2 }, [["xdotool", "mousemove", "1", "2"], ["xdotool", "mouseup", "1"]]],
  [{ action: "move", x: 1, y: 2 }, [["xdotool", "mousemove", "1", "2"]]],
  [{ action: "drag", path: [[1, 2], [3, 4], [5, 6]] }, [["xdotool", "mousemove", "1", "2"], ["xdotool", "mousedown", "1"],
    ["xdotool", "mousemove", "3", "4"], ["xdotool", "mousemove", "5", "6"], ["xdotool", "mouseup", "1"]]],
  [{ action: "scroll", x: 5, y: 6, direction: "down", amount: 3 }, [["xdotool", "mousemove", "5", "6"], ["xdotool", "click", "--repeat", "3", "5"]]],
  [{ action: "key", combo: "ctrl+l" }, [["xdotool", "key", "--", "ctrl+l"]]],
  [{ action: "key", combo: "shift", hold: 0.1 }, [["xdotool", "keydown", "--", "shift"], ["xdotool", "keyup", "--", "shift"]]],
  [{ action: "clipboard_set", text: "hi" }, [["sh", "-c", "xclip -selection clipboard -i >/dev/null 2>&1"]]],
])("%o runs its commands, then returns a screenshot with the cursor", async (args, commands) => {
  const result = await run(tool, args, fakeApi().api);
  expect(fake.calls.map((c) => c.argv)).toEqual([...commands, ...SHOT]);
  expect(result.content).toEqual([{ type: "text", text: `${args.action} — cursor at 1,2` },
    { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
  expect(fake.waits).toEqual([true]);
});

test("clipboard_set gives its text as input", async () => {
  await run(tool, { action: "clipboard_set", text: "hi" }, fakeApi().api);
  expect(fake.calls[0]!.input).toBe("hi");
});

test("the screenshot is taken 500 ms after the action; screenshot: false returns only the text line", async () => {
  const started = Date.now();
  await run(tool, { action: "click", x: 1, y: 2 }, fakeApi().api);
  expect(Date.now() - started).toBeGreaterThanOrEqual(495);
  fake.calls.length = 0;
  const result = await run(tool, { action: "move", x: 1, y: 2, screenshot: false }, fakeApi().api);
  expect(result.content).toEqual([{ type: "text", text: "move — cursor at 1,2" }]);
  expect(fake.calls.map((c) => c.argv)).toEqual([["xdotool", "mousemove", "1", "2"], ["xdotool", "getmouselocation", "--shell"]]);
});

test("type sends 50-character chunks, unparsed", async () => {
  const text = `it's "$HOME" \`x\`\n${"a".repeat(110)}`;
  await run(tool, { action: "type", text }, fakeApi().api);
  const typed = fake.calls.filter((c) => c.argv[1] === "type");
  expect(typed.map((c) => c.argv.slice(0, 5))).toEqual(Array(3).fill(["xdotool", "type", "--delay", "12", "--"]));
  expect(typed.map((c) => c.argv[5]!.length)).toEqual([50, 50, text.length - 100]);
  expect(typed.map((c) => c.argv[5]).join("")).toBe(text);
});

test("zoom crops the region and scales it to 1280×800", async () => {
  const result = await run(tool, { action: "zoom", region: [10, 20, 110, 70] }, fakeApi().api);
  expect(fake.calls[0]!.argv).toEqual(["import", "-window", "root", "-crop", "100x50+10+20", "+repage", "-resize", "1280x800", "png:-"]);
  expect(resultText(result)).toBe("zoom — cursor at 1,2");
});

test("wait sleeps on the host", async () => {
  const result = await run(tool, { action: "wait", seconds: 0.1 }, fakeApi().api);
  expect(resultText(result)).toBe("waited 0.1 s");
  expect(fake.calls).toEqual([]);
});

test("aborting a wait returns at once", async () => {
  const abort = new AbortController();
  const started = Date.now();
  const call = run(tool, { action: "wait", seconds: 10 }, fakeApi().api, abort.signal);
  setTimeout(() => abort.abort(), 50);
  await call.catch(() => {});
  expect(Date.now() - started).toBeLessThan(5000);
});

test("a job outside the container can act on the desktop: reads don't wait for the image, acting actions do", async () => {
  const { api, docs } = fakeApi();
  expect((await run(tool, { action: "screenshot" }, api)).content![1]).toMatchObject({ type: "image" });
  expect(resultText(await run(tool, { action: "cursor_position" }, api))).toBe("cursor at 1,2");
  expect(resultText(await run(tool, { action: "clipboard_get" }, api))).toBe("copied");
  expect(fake.waits).toEqual([false, false, false]);
  fake.calls.length = 0;
  expect(resultText(await run(tool, { action: "click", x: 1, y: 2, screenshot: false }, api))).toBe("click — cursor at 1,2");
  expect(fake.calls.map((c) => c.argv)).toContainEqual(["xdotool", "click", "--repeat", "1", "1"]);
  expect(fake.waits).toEqual([false, false, false, true]);
  expect(docs["japa.desktop-lock:1"]).toEqual({ job: "1" });
});

test("the chief of staff reads the desktop, and starts a job to act on it", async () => {
  const { api, docs } = fakeApi({ conversationId: 1, job: "" });
  expect(resultText(await run(tool, { action: "cursor_position" }, api))).toBe("cursor at 1,2");
  fake.calls.length = 0;
  expect(resultText(await run(tool, { action: "click", x: 1, y: 2 }, api))).toBe(COS);
  expect(fake.calls).toEqual([]);
  expect(docs["japa.desktop-lock:1"]?.job).toBeUndefined();
});

test("a desktop that is not ready answers as text", async () => {
  fake.desktop.ready = () => Promise.reject(new Error("The desktop needs Docker: no"));
  expect(resultText(await run(tool, { action: "screenshot" }, fakeApi().api))).toBe("The desktop needs Docker: no");
});

test("a failing command and a missing parameter answer as text", async () => {
  fake.reply((argv) => argv[1] === "click", { code: 1, stderr: "xdotool: bad\n" });
  expect(resultText(await run(tool, { action: "click", x: 1, y: 2 }, fakeApi().api))).toBe("click failed: xdotool: bad");
  fake.reply((argv) => argv[1] === "click", { code: 2 });
  expect(resultText(await run(tool, { action: "click", x: 1, y: 2 }, fakeApi().api))).toBe("click failed: exit code 2");
  expect(resultText(await run(tool, { action: "click", y: 2 }, fakeApi().api))).toBe("click needs x and y");
});

test("the first acting call takes the lock; reads never do", async () => {
  const { api, docs } = fakeApi();
  await run(tool, { action: "screenshot" }, api);
  expect(docs["japa.desktop-lock:1"]?.job).toBeUndefined();
  await run(tool, { action: "move", x: 1, y: 2, screenshot: false }, api);
  expect(docs["japa.desktop-lock:1"]).toEqual({ job: "1" });
});

test("a second job waits while the first holds the desktop", async () => {
  const first = fakeApi();
  await run(tool, { action: "move", x: 1, y: 2, screenshot: false }, first.api);
  const jobs = first.docs["japa.jobs:1"]!.jobs;
  jobs["2"] = { id: "2", status: "running" };
  const second = fakeApi({ conversationId: 8, job: "2", docs: first.docs });
  let done = false;
  const moving = run(tool, { action: "move", x: 3, y: 4, screenshot: false }, second.api).then(() => (done = true));
  await vi.waitFor(() => expect(jobs["2"].progress).toBe("Waiting for the desktop (in use by job 1)"));
  expect(done).toBe(false);
  jobs["1"].status = "done";
  await moving;
  expect(first.docs["japa.desktop-lock:1"]).toEqual({ job: "2" });
  expect(jobs["2"].progress).toBeUndefined();
});

/** Job 2's docs, with job 1 holding the lock in `status` (or gone). */
function heldBy(status?: string) {
  const docs: Record<string, any> = {
    "japa.desktop-lock:1": { job: "1" },
    "japa.jobs:1": { nextId: 3, jobs: { "2": { id: "2", status: "running" } } },
  };
  if (status) docs["japa.jobs:1"].jobs["1"] = { id: "1", status };
  return fakeApi({ conversationId: 8, job: "2", docs });
}

test("a job waiting on the user keeps the desktop; a finished, failed, stopped or vanished one does not", async () => {
  const waiting = heldBy("needs_input");
  const abort = new AbortController();
  let settled = false;
  const call = run(tool, { action: "move", x: 1, y: 2, screenshot: false }, waiting.api, abort.signal);
  call.then(() => (settled = true), () => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(settled).toBe(false);
  abort.abort();
  await expect(call).rejects.toThrow();
  expect(waiting.docs["japa.desktop-lock:1"]).toEqual({ job: "1" });

  for (const status of ["done", "failed", "cancelled", undefined]) {
    const { api, docs } = heldBy(status);
    const aborted = withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT);
    await expect(claimDesktop(api, aborted)).resolves.toBeUndefined(); // any wait would reject at once
    expect(docs["japa.desktop-lock:1"]).toEqual({ job: "2" });
  }
});
