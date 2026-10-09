import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { OMITTED, recentImagesOnly } from "../extensions/desktop/images.ts";
import { desktopExtension } from "../extensions/desktop/index.ts";
import { LockDoc } from "../extensions/desktop/lock.ts";
import { fakeDocker, testConfig } from "./desktop-helpers.ts";
import { bootErrors, bootTest, NO_BWRAP, waitFor } from "./helpers.ts";
import { ask, call, reported, say, script } from "./jobs-helpers.ts";

test("only the 3 newest screenshots stay in the model's context", () => {
  const shot = (toolName: string) => ({ role: "toolResult", toolCallId: toolName, toolName, isError: false, timestamp: 0,
    content: [{ type: "text", text: "t" }, { type: "image", data: toolName, mimeType: "image/png" }] }) as Message;
  const user = { role: "user", timestamp: 0, content: [{ type: "image", data: "u", mimeType: "image/png" }] } as Message;
  const messages = [shot("computer"), user, shot("browser"), shot("computer"), shot("other"), shot("browser"), shot("computer")];
  const kept = recentImagesOnly(messages);
  const images = (m: Message) => (typeof m.content === "string" ? [] : m.content.filter((c) => c.type === "image"));
  expect(kept.map((m) => images(m).length)).toEqual([0, 1, 0, 1, 1, 1, 1]);
  expect(JSON.stringify(kept[0])).toContain(OMITTED);
  expect(images(messages[0]!)).toHaveLength(1); // input unchanged
});

test("the chief of staff's glances: the model sees 3 screenshots, storage keeps all 5", async () => {
  const fake = fakeDocker();
  const { daemon, faux } = await bootTest({}, [desktopExtension(testConfig(fake.docker))]);
  let seen: Message[] = [];
  const step: FauxResponseFactory = ({ messages }) => {
    if (messages.filter((m) => m.role === "toolResult").length < 5) return call("computer", { action: "screenshot" });
    seen = [...messages];
    return say("done");
  };
  faux.setResponses(Array.from({ length: 6 }, () => step));
  await ask(daemon, "look");
  const images = (ms: Message[]) => ms.flatMap((m) => (m.role === "toolResult" ? m.content : [])).filter((c) => c.type === "image");
  expect(images(seen)).toHaveLength(3);
  expect(JSON.stringify(seen).split(OMITTED)).toHaveLength(3);
  const stored = (await daemon.root.entries({}, 200, undefined, ctx)).items.flatMap((e) => e.model ?? []);
  expect(images(stored)).toHaveLength(5);
  await daemon.close();
});

test("a default install loads the desktop without touching Docker", async () => {
  const { daemon } = await bootTest();
  expect(bootErrors(daemon)).toEqual([]);
  expect(daemon.status().extensions).toContainEqual({ name: "desktop",
    summary: "Gives me my own computer: a desktop with a browser and apps that I can see and operate",
    provides: ["tool"], status: "noVNC: http://127.0.0.1:6080/vnc.html (password: secret desktop.vncPassword)", state: "on" });
  expect(daemon.capabilities()).toContain("- operator: Operates japa's own desktop computer — browser and apps — to get things done on websites and in programs.");
  await daemon.close();
});

test("the desktop builds and starts in the background when japa starts, unless autostart is off", async () => {
  const saved = process.env.JAPA_DESKTOP_AUTOSTART;
  delete process.env.JAPA_DESKTOP_AUTOSTART;
  try {
    const fake = fakeDocker();
    fake.state.image = false;
    const { daemon } = await bootTest({}, [desktopExtension(testConfig(fake.docker))]);
    await waitFor(() => fake.state.container?.running === true);
    expect(fake.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["build", "run"]));
    await daemon.close();

    const off = fakeDocker();
    const { daemon: d2 } = await bootTest({ extensions: { desktop: { autostart: false } } }, [
      desktopExtension(testConfig(off.docker)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(off.calls).toEqual([]);
    await d2.close();
  } finally {
    process.env.JAPA_DESKTOP_AUTOSTART = saved;
  }
});

test("the desktop extension provides no environment", () => {
  const ext = desktopExtension(testConfig(fakeDocker().docker));
  expect(ext.provides!.environment).toBeUndefined();
  expect((ext.provides!.tool as ToolRegistration[]).map((t) => t.name)).toEqual(["computer", "browser"]);
});

test.skipIf(NO_BWRAP)("a job outside the container can act on the desktop", async () => {
  const fake = fakeDocker();
  const { daemon, faux } = await bootTest({}, [desktopExtension(testConfig(fake.docker))]);
  script(faux, (role, text) =>
    text === "go" ? call("job_start", { title: "Click", brief: "click it" })
    : text === "click it" ? fauxAssistantMessage([fauxToolCall("computer", { action: "click", x: 1, y: 2 })], { stopReason: "toolUse" })
    : role === "toolResult" && text.startsWith("click — cursor") ? call("job_complete", { summary: "clicked" })
    : undefined);
  await ask(daemon, "go");
  await waitFor(async () => (await reported(daemon)).length > 0, 10_000);
  expect(fake.calls).toContainEqual(["exec", "-u", "japa", "japa-desktop", "xdotool", "mousemove", "1", "2"]);
  expect(await daemon.harness.snapshot(LockDoc, ROOT_CONVERSATION_ID, ctx)).toEqual({ job: "1" });
  await daemon.close();
});
