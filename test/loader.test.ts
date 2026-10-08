import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { discoverExtensions, linkSdk, loadExtensions } from "../src/kernel/loader.ts";
import { tempHome } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sdk = join(repoRoot, "src/sdk.ts");

/** Writes `<dir>/<name>/index.ts` with `body` and returns `dir`. */
function writeExtension(dir: string, name: string, body: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "index.ts"), body);
  return dir;
}

/** Source of an extension manifest module importing from the repo's SDK. */
function manifest(fields: string): string {
  return `import { defineJapaExtension } from ${JSON.stringify(sdk)};\nexport default defineJapaExtension({ ${fields} });\n`;
}

const tempDir = () => mkdtempSync(join(tmpdir(), "japa-ext-"));

test("workspace extension overrides packaged one by name", () => {
  const packaged = tempDir();
  const workspace = tempDir();
  writeExtension(packaged, "a", manifest(`name: "a", summary: "s"`));
  writeExtension(packaged, "b", manifest(`name: "b", summary: "s"`));
  writeExtension(workspace, "a", manifest(`name: "a", summary: "s"`));
  expect(discoverExtensions([packaged, workspace])).toEqual([
    { name: "a", file: join(workspace, "a/index.ts") },
    { name: "b", file: join(packaged, "b/index.ts") },
  ]);
});

test("missing dirs and dirs without index.ts are skipped", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "empty"));
  expect(discoverExtensions([join(dir, "missing"), dir])).toEqual([]);
});

test("broken extensions are reported, valid ones load", async () => {
  const dir = tempDir();
  writeExtension(dir, "good", manifest(`name: "good", summary: "Does good"`));
  writeExtension(dir, "throws", `throw new Error("boom");\n`);
  writeExtension(dir, "invalid", manifest(`name: "invalid", summary: ""`));
  const { extensions, errors } = await loadExtensions(discoverExtensions([dir]));
  expect(extensions.map((e) => e.name)).toEqual(["good"]);
  expect(errors.map((e) => e.name).sort()).toEqual(["invalid", "throws"]);
  expect(errors.find((e) => e.name === "throws")!.error).toMatch(/boom/);
  expect(errors.find((e) => e.name === "invalid")!.error).toBe("summary is required");
});

test("manifest name must match directory", async () => {
  const dir = writeExtension(tempDir(), "dir-name", manifest(`name: "other", summary: "s"`));
  const { extensions, errors } = await loadExtensions(discoverExtensions([dir]));
  expect(extensions).toEqual([]);
  expect(errors).toEqual([{ name: "dir-name", error: "manifest name must match directory" }]);
});

test("an extension providing a non-core contract fails alone; a contracts field is ignored", async () => {
  const dir = tempDir();
  writeExtension(dir, "old", manifest(`name: "old", summary: "s", contracts: [{ name: "search-engine", docs: "d",
    phase: "runtime", cardinality: "many", validate: () => undefined }], provides: { "search-engine": [{ name: "e" }] }`));
  writeExtension(dir, "defines-only", manifest(`name: "defines-only", summary: "s", contracts: [{ name: "x" }]`));
  writeExtension(dir, "good", manifest(`name: "good", summary: "s"`));
  const { extensions, errors } = await loadExtensions(discoverExtensions([dir]));
  expect(extensions.map((e) => e.name)).toEqual(["defines-only", "good"]);
  expect(errors).toEqual([{ name: "old", error: 'unknown contract "search-engine"' }]);
});

test("a module without a default export is reported", async () => {
  const dir = writeExtension(tempDir(), "no-default", `export const x = 1;\n`);
  const { errors } = await loadExtensions(discoverExtensions([dir]));
  expect(errors).toEqual([{ name: "no-default", error: "missing default export" }]);
});

test("linkSdk creates the japa symlink", () => {
  const home = tempHome();
  linkSdk(home, repoRoot);
  linkSdk(home, repoRoot); // idempotent
  expect(realpathSync(join(home, "node_modules/japa"))).toBe(realpathSync(repoRoot));
});

test("linkSdk writes a module package.json unless one exists", () => {
  const home = tempHome();
  linkSdk(home, repoRoot);
  expect(JSON.parse(readFileSync(join(home, "package.json"), "utf8"))).toEqual({ type: "module" });

  const other = tempHome();
  writeFileSync(join(other, "package.json"), `{"name":"mine"}`);
  linkSdk(other, repoRoot);
  expect(readFileSync(join(other, "package.json"), "utf8")).toBe(`{"name":"mine"}`);
});
