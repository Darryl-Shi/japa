import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { expect, test, vi } from "vitest";
import { connect } from "../extensions/gateway/client.ts";
import { type ServerMessage, socketPath } from "../extensions/gateway/protocol.ts";
import { boot } from "../src/kernel/boot.ts";
import type { Status } from "../src/kernel/contracts.ts";
import { bootTest, tempHome, testKit } from "./helpers.ts";

test("attach, submit, and receive the answer", async () => {
  const { daemon, faux, home } = await bootTest();
  faux.setResponses([fauxAssistantMessage([fauxText("Hi there")])]);
  const client = await connect(home);
  const seen: ServerMessage[] = [];
  client.onMessage((m) => seen.push(m));
  client.send({ type: "attach" });
  client.send({ type: "submit", text: "hello" });
  await vi.waitFor(() => expect(JSON.stringify(seen)).toContain("Hi there"));
  expect(seen[0].type === "events" && seen[0].events[0].type).toBe("snapshot");
  client.close();
  await daemon.close();
});

test("malformed lines and abrupt disconnects do not affect other clients", async () => {
  const { daemon, home } = await bootTest();
  const raw = createConnection(socketPath(home));
  raw.write("{not json\n");
  raw.destroy();
  const client = await connect(home);
  const seen: ServerMessage[] = [];
  client.onMessage((m) => seen.push(m));
  client.send({ type: "status" });
  await vi.waitFor(() => expect(seen.some((m) => m.type === "status")).toBe(true));
  client.close();
  await daemon.close();
});

test("a submit without text is rejected and later submits still work", async () => {
  const { daemon, faux, home } = await bootTest();
  const raw = createConnection(socketPath(home));
  let rawData = "";
  raw.on("data", (d) => (rawData += d));
  raw.write('{"type":"submit"}\n');
  await vi.waitFor(() => expect(rawData).toContain('"type":"error"'));
  raw.destroy();
  faux.setResponses([fauxAssistantMessage([fauxText("Still fine")])]);
  const client = await connect(home);
  const seen: ServerMessage[] = [];
  client.onMessage((m) => seen.push(m));
  client.send({ type: "attach" });
  client.send({ type: "submit", text: "hello" });
  await vi.waitFor(() => expect(JSON.stringify(seen)).toContain("Still fine"));
  client.close();
  await daemon.close();
});

test("status lists extensions and errors", async () => {
  const { daemon, home } = await bootTest();
  const client = await connect(home);
  const seen: ServerMessage[] = [];
  client.onMessage((m) => seen.push(m));
  client.send({ type: "status" });
  await vi.waitFor(() => expect(seen.find((m) => m.type === "status")).toBeTruthy());
  const status = (seen.find((m) => m.type === "status") as { status: Status }).status;
  expect(status.extensions.map((e) => e.name)).toEqual(
    expect.arrayContaining(["gateway", "local-env", "providers", "test-kit"]),
  );
  client.close();
  await daemon.close();
});

test("connect fails clearly when the daemon is not running", async () => {
  await expect(connect(tempHome())).rejects.toThrow("japa is not running. Start it with: japa daemon");
});

test("a stale socket file is replaced", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  writeFileSync(socketPath(home), "");
  const daemon = await boot({ home, extensions: [kit.extension] });
  expect(daemon.status().errors).toEqual([]);
  await daemon.close();
});
