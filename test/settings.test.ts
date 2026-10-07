import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_SETTINGS, japaHome, loadSettings } from "../src/kernel/settings.ts";
import { tempHome } from "./helpers.ts";

test("defaults when settings.json is missing", () => {
  expect(loadSettings(tempHome())).toEqual(DEFAULT_SETTINGS);
});

test("merges user settings over defaults", () => {
  const s = loadSettings(tempHome({ models: { cos: { provider: "p", modelId: "m" } } }));
  expect(s.models.cos).toEqual({ provider: "p", modelId: "m" });
  expect(s.storage.adapter).toBe("sqlite");
});

test("invalid JSON names the file", () => {
  const home = tempHome();
  writeFileSync(join(home, "settings.json"), "{nope");
  expect(() => loadSettings(home)).toThrow(/Invalid .*settings\.json/);
});

test("japaHome defaults to ~/.japa", () => {
  const original = process.env.JAPA_HOME;
  delete process.env.JAPA_HOME;
  try {
    expect(japaHome()).toBe(join(homedir(), ".japa"));
  } finally {
    if (original === undefined) delete process.env.JAPA_HOME;
    else process.env.JAPA_HOME = original;
  }
});

test("japaHome honors JAPA_HOME", () => {
  const original = process.env.JAPA_HOME;
  process.env.JAPA_HOME = "/tmp/custom-japa-home";
  try {
    expect(japaHome()).toBe("/tmp/custom-japa-home");
  } finally {
    if (original === undefined) delete process.env.JAPA_HOME;
    else process.env.JAPA_HOME = original;
  }
});
