import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { expect, test, vi } from "vitest";
import { connect } from "../extensions/gateway/client.ts";
import { type ServerMessage, socketPath } from "../extensions/gateway/protocol.ts";
import { boot } from "../src/kernel/boot.ts";
import type { Status } from "../src/kernel/contracts.ts";
import type { SecretRequest } from "../src/kernel/secret-requests.ts";
import { bootTest, probe, tempHome, testKit, waitFor } from "./helpers.ts";
import { call, script, texts } from "./jobs-helpers.ts";

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

test("the gateway submits with its origin and still shows input from other surfaces", async () => {
  const { extension, surface } = probe();
  const { daemon, home } = await bootTest({}, [extension]);
  const client = await connect(home);
  const seen: ServerMessage[] = [];
  client.onMessage((m) => seen.push(m));
  client.send({ type: "attach" });
  client.send({ type: "submit", text: "hello" });
  await surface().root.submit("from the phone", undefined, { surface: "fake", chat: "9" });
  await vi.waitFor(() => expect(JSON.stringify(seen)).toMatch(/"requestId":"surface:gateway::[0-9a-f-]{36}"/));
  await vi.waitFor(() => expect(JSON.stringify(seen)).toContain("from the phone"));
  client.close();
  await daemon.close();
});

test("attach streams the job board", async () => {
  const { daemon, faux, home } = await bootTest();
  script(faux, (_role, text) => (text === "start sum" ? call("job_start", { title: "Sum", brief: "Add" }) : undefined));
  const client = await connect(home);
  const boards: unknown[][] = [];
  client.onMessage((m) => m.type === "jobs" && boards.push(m.jobs));
  client.send({ type: "attach" });
  await vi.waitFor(() => expect(boards[0]).toEqual([]));
  client.send({ type: "submit", text: "start sum" });
  await vi.waitFor(() => expect(boards.at(-1)).toMatchObject([{ id: "1", title: "Sum" }]));
  client.close();
  await daemon.close();
});

test("attach streams pending secret requests and a secret message fulfils one", async () => {
  const { daemon, faux, home } = await bootTest();
  script(faux, (role, text) =>
    role === "user" && text === "go" ? call("secret_request", { name: "svc.token", why: "to sync" }) : undefined,
  );
  const client = await connect(home);
  const lists: SecretRequest[][] = [];
  const seen: ServerMessage[] = [];
  client.onMessage((m) => {
    seen.push(m);
    if (m.type === "secrets") lists.push(m.pending);
  });
  client.send({ type: "attach" });
  client.send({ type: "submit", text: "go" });
  await vi.waitFor(() => expect(lists.at(-1)).toMatchObject([{ name: "svc.token", why: "to sync" }]));
  client.send({ type: "secret", requestId: lists.at(-1)![0]!.id, value: "s3cr3t" });
  await vi.waitFor(() => expect(lists.at(-1)).toEqual([]));
  expect(JSON.stringify(seen)).not.toContain("s3cr3t");
  client.close();
  await daemon.close();
});

test("a decline message withdraws the request and tells the CoS", async () => {
  const { daemon, faux, home } = await bootTest();
  script(faux, (role, text) =>
    role === "user" && text === "go" ? call("secret_request", { name: "svc.token", why: "to sync" }) : undefined,
  );
  const client = await connect(home);
  const lists: SecretRequest[][] = [];
  client.onMessage((m) => m.type === "secrets" && lists.push(m.pending));
  client.send({ type: "attach" });
  client.send({ type: "submit", text: "go" });
  await vi.waitFor(() => expect(lists.at(-1)).toMatchObject([{ name: "svc.token" }]));
  client.send({ type: "decline", requestId: lists.at(-1)![0]!.id });
  await vi.waitFor(() => expect(lists.at(-1)).toEqual([]));
  await waitFor(async () => (await texts(daemon.root, "user")).includes("[secret svc.token declined]"));
  client.close();
  await daemon.close();
});

test("a decline without a request id is invalid", async () => {
  const { daemon, home } = await bootTest();
  const client = await connect(home);
  const seen: ServerMessage[] = [];
  client.onMessage((m) => seen.push(m));
  client.send({ type: "decline" } as never);
  await vi.waitFor(() => expect(seen).toContainEqual({ type: "error", message: "Invalid message" }));
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
