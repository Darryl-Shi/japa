import type { ToolRegistration } from "@earendil-works/pi-durable";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Api } from "../extensions/google/api.ts";
import google from "../extensions/google/index.ts";
import { googleRequest } from "../extensions/google/request.ts";
import { validateExtension } from "../src/kernel/extension.ts";
import { discoverExtensions, loadExtensions } from "../src/kernel/loader.ts";
import { schemaProblems } from "../src/kernel/tool-schema.ts";
import { bootTest, REPO_EXTENSIONS, waitFor } from "./helpers.ts";
import { tool } from "./jobs-helpers.ts";

afterEach(() => vi.unstubAllGlobals());

const NO_CLIENT =
  "Google isn't set up: ask the user for google.clientId and google.clientSecret with secret_request " +
  '(a Desktop app OAuth client; see japa\'s README), then connect({ extension: "google" }).';
const NOT_SIGNED_IN = 'Not signed in to Google (or the sign-in expired): call connect({ extension: "google" }).';

const tools = () => (google.provides?.tool ?? []) as ToolRegistration[];

/** Boots with google's client id and secret stored, so google is available. */
const bootClient = () => bootTest({}, [], undefined, { "google.clientId": "client-1", "google.clientSecret": "shh" });

test("the manifest is valid, and provides the six tools with portable schemas", () => {
  expect(validateExtension(google)).toEqual([]);
  expect(tools().map((t) => t.name)).toEqual(["gmail", "drive", "calendar", "contacts", "tasks", "google_request"]);
  for (const t of tools()) expect([t.name, schemaProblems(t.parameters)]).toEqual([t.name, []]);
  // As `japa check` requires.
  for (const t of tools()) expect([t.name, t.description.length <= 1024]).toEqual([t.name, true]);
  expect(google.authorize).toBeDefined();
  expect(google.secrets).toEqual([
    { name: "google.clientId", description: "Google OAuth client ID (a Desktop app client, see the README)" },
    { name: "google.clientSecret", description: "Google OAuth client secret" },
    { name: "google.token", description: "Google sign-in (made by connecting)", generated: true },
  ]);
});

test("the docs name every tool and the recovery steps", () => {
  for (const name of ["gmail", "drive", "calendar", "contacts", "tasks", "google_request"]) {
    expect(google.docs).toContain(name);
  }
  expect(google.docs).toContain('connect({ extension: "google" })');
  expect(google.docs).toContain("secret_request");
  expect(google.docs).toContain("Confirm with the user before sending mail, deleting, trashing or sharing");
  expect(google.docs).toContain("attachments/google/");
});

// The `japa check` path for a workspace extension copies it out of the repo, which a packaged extension importing
// `../../src/sdk.ts` can't survive; so: it loads with the other packaged extensions, as boot loads them.
test("the packaged extensions load google without errors", async () => {
  const { extensions, errors } = await loadExtensions(discoverExtensions([REPO_EXTENSIONS]));
  expect(errors.filter((e) => e.name === "google")).toEqual([]);
  expect(extensions.map((e) => e.name)).toContain("google");
});

test("without its client secrets google is not set up and hidden from the CoS", async () => {
  const { daemon } = await bootTest();
  expect(daemon.status().extensions).toContainEqual(expect.objectContaining({ name: "google", state: "not set up" }));
  expect(daemon.capabilities()).not.toContain("- google: ");
  await daemon.close();
});

test("a booted daemon with the client lists google as not connected, with its tools", async () => {
  const { daemon } = await bootClient();
  expect(daemon.status().errors).toEqual([]);
  await waitFor(() => daemon.status().extensions.some((e) => e.name === "google" && e.status === "not connected"));
  expect(daemon.status().extensions).toContainEqual({
    name: "google",
    summary: "Gmail, Drive, Calendar, Contacts and Tasks for one Google account",
    provides: ["tool"],
    status: "not connected",
    state: "on",
  });
  expect(daemon.capabilities()).toContain("- google: ");
  await daemon.close();
});

test("when the client secrets go missing a tool says how to set Google up", async () => {
  const { daemon, faux, home } = await bootClient();
  rmSync(join(home, "secrets/google.clientId"));
  expect(await tool(daemon, faux, "gmail", { action: "labels" })).toBe(NO_CLIENT);
  await daemon.close();
});

test("with the client but no sign-in a tool says to connect", async () => {
  const { daemon, faux } = await bootClient();
  expect(await tool(daemon, faux, "gmail", { action: "labels" })).toBe(NOT_SIGNED_IN);
  await daemon.close();
});

test("google_request refuses URLs outside https://*.googleapis.com", async () => {
  const { daemon, faux } = await bootClient();
  expect(await tool(daemon, faux, "google_request", { method: "GET", url: "https://evil.example/x" })).toBe(
    "Only https://*.googleapis.com URLs are allowed.",
  );
  await daemon.close();
});

test("signed in, gmail labels sends the bearer token and formats the reply", async () => {
  const { daemon, faux, home } = await bootClient();
  const token = { access_token: "at-1", refresh_token: "rt-1", expires_at: Date.now() + 3600_000, scope: "", email: "me@x.com" };
  writeFileSync(join(home, "secrets/google.token"), JSON.stringify(token));
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ labels: [{ id: "INBOX", name: "INBOX" }, { id: "Label_1", name: "Receipts" }] }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await tool(daemon, faux, "gmail", { action: "labels" })).toBe("INBOX (INBOX)\nReceipts (Label_1)");
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer at-1");
  await waitFor(() => daemon.status().extensions.some((e) => e.name === "google" && e.status === "connected as me@x.com"));
  await daemon.close();
});

/** An Api whose `raw` records its call and answers `reply`. */
function rawApi(reply: { status: number; body: string }) {
  const calls: unknown[][] = [];
  const api = {
    raw: async (...args: unknown[]) => {
      calls.push(args);
      return reply;
    },
  } as unknown as Api;
  return { api, calls };
}

test("googleRequest sends the method, query and body, and replies with the status and body", async () => {
  const { api, calls } = rawApi({ status: 200, body: '{"ok":true}' });
  const url = "https://people.googleapis.com/v1/people/me";
  const out = await googleRequest(api, { method: "PATCH", url, query: { personFields: "names" }, body: { a: 1 } });
  expect(out).toBe('HTTP 200\n{"ok":true}');
  expect(calls).toEqual([["PATCH", url, { query: { personFields: "names" }, body: { a: 1 } }]]);
  expect(await googleRequest(rawApi({ status: 404, body: "nope" }).api, { method: "GET", url })).toBe("HTTP 404\nnope");
});

test("googleRequest allows only https googleapis.com hosts", async () => {
  for (const url of [
    "http://gmail.googleapis.com/x",
    "https://googleapis.com.evil.example/x",
    "https://evilgoogleapis.com/x",
    "not a url",
    "https://www.google.com/x",
  ]) {
    const { api, calls } = rawApi({ status: 200, body: "" });
    expect([url, await googleRequest(api, { method: "GET", url })]).toEqual([url, "Only https://*.googleapis.com URLs are allowed."]);
    expect(calls).toEqual([]);
  }
});
