import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { markOffered } from "../src/cli/configure.ts";
import { openSetupContext } from "../src/cli/context.ts";
import type { Exec, ExecResult } from "../src/cli/exec.ts";
import type { Choice } from "../src/cli/prompt.ts";
import { type ServiceEnv, unitPath } from "../src/cli/service.ts";
import { runSetup, type SetupOptions } from "../src/cli/setup.ts";
import { REPO_EXTENSIONS, tempHome } from "./helpers.ts";
import { scripted } from "./prompt-helpers.ts";

/** An extension with just one secret, used as "the new thing" `--whats-new` and the extensions step find. */
const FIXTURE_SOURCE = `import { defineJapaExtension } from "japa/sdk";

export default defineJapaExtension({
  name: "fixture",
  summary: "Fixture extension for setup tests",
  secrets: [{ name: "fixture.token", description: "Fixture token" }],
});
`;

function writeFixture(home: string): void {
  mkdirSync(join(home, "extensions", "fixture"), { recursive: true });
  writeFileSync(join(home, "extensions", "fixture", "index.ts"), FIXTURE_SOURCE);
}

/** An extension with nothing to configure: no secrets, no settings. */
function writePlain(home: string): void {
  mkdirSync(join(home, "extensions", "plain"), { recursive: true });
  writeFileSync(
    join(home, "extensions", "plain", "index.ts"),
    `import { defineJapaExtension } from "japa/sdk";\n\nexport default defineJapaExtension({ name: "plain", summary: "Plain extension for setup tests" });\n`,
  );
}

/** A fake `Exec` that records every call and answers via `answer(cmd, args)` (default: success, no output);
 * mirrors test/service.test.ts's helper of the same name. */
function fakeExec(answer: (cmd: string, args: string[]) => Partial<ExecResult> = () => ({})) {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const a = answer(cmd, args);
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { exec, calls };
}

function makeServiceEnv(overrides: Partial<ServiceEnv> = {}): ServiceEnv {
  return {
    platform: "linux",
    userHome: tempHome(),
    configHome: tempHome(),
    command: ["/home/x/.local/bin/japa", "daemon"],
    japaHome: tempHome(),
    customHome: false,
    path: "/usr/bin:/bin",
    user: "alice",
    uid: 1000,
    exec: fakeExec().exec,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    interactive: true,
    service: false,
    whatsNew: false,
    env: {},
    serviceEnv: makeServiceEnv(),
    extensionDirs: [REPO_EXTENSIONS],
    log: () => {},
    ...overrides,
  };
}

const readSettings = (home: string) => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
const readSetupJson = (home: string) => JSON.parse(readFileSync(join(home, "setup.json"), "utf8"));
const secretFile = (home: string, name: string) => join(home, "secrets", name);

/** Picks the first offered choice; some tests also want to know which one, via `capture`. */
const first =
  (capture?: (value: string) => void) =>
  (choices: Choice<unknown>[]): unknown => {
    const value = choices[0]!.value as string;
    capture?.(value);
    return value;
  };

/** Picks the offered choice whose label starts with `label`. */
const pick = (label: string) => (choices: Choice<unknown>[]) => choices.find((c) => c.label.startsWith(label))!.value;

/** Picks the offered choices labelled `labels` in a multi-select. */
const picks = (...labels: string[]) => (choices: Choice<unknown>[]) =>
  choices.filter((c) => labels.includes(c.label)).map((c) => c.value);

/** The models step's questions on a first run: anthropic, a pasted key `sk-1`, its first model, shared by all. */
const MODELS_FIRST_RUN = (capture?: (value: string) => void): [string, unknown][] => [
  ["Which AI provider", "anthropic"],
  ["How should japa connect", pick("Enter Anthropic API key")],
  ["Anthropic API key", "sk-1"],
  ["Which model", first(capture)],
  ["too?", true],
];

/** Runs a first run that writes `models.cos` and an anthropic key, setting up no integrations, with the service
 * skipped (`--no-service`); used to seed a home whose rerun menu doesn't need to ask about models. */
async function seedModels(home: string): Promise<void> {
  const p = scripted([...MODELS_FIRST_RUN(), ["Set up any integrations now?", []]]);
  await runSetup(home, p, makeOptions());
  p.done();
}

test("first run writes models, key and extension choices, and reports no service manager", async () => {
  const home = tempHome();
  writeFixture(home);
  let chosenModel: string | undefined;
  const logs: string[] = [];
  const { exec } = fakeExec(() => ({ code: 1 })); // systemctl --user show-environment fails: no service manager

  const p = scripted([
    ...MODELS_FIRST_RUN((m) => (chosenModel = m)),
    ["Set up any integrations now?", picks("fixture")],
    ["Fixture token", "tok-xyz"],
  ]);

  const code = await runSetup(
    home,
    p,
    makeOptions({
      service: true,
      serviceEnv: makeServiceEnv({ exec }),
      extensionDirs: [REPO_EXTENSIONS, join(home, "extensions")],
      waitMs: 50,
      log: (s) => logs.push(s),
    }),
  );

  expect(code).toBe(0);
  p.done();
  expect(readSettings(home).models.cos).toEqual({ provider: "anthropic", modelId: chosenModel });
  expect(readFileSync(secretFile(home, "anthropic.apiKey"), "utf8")).toBe("sk-1");
  expect(readFileSync(secretFile(home, "fixture.token"), "utf8")).toBe("tok-xyz");
  const joined = logs.join("\n");
  expect(joined).toContain("/etc/wsl.conf"); // the no-systemd reason
  expect(joined).toContain("start japa with: japa daemon");
});

test("first run installs and starts the service without asking, and says so when it doesn't answer", async () => {
  const home = tempHome();
  const logs: string[] = [];

  const p = scripted([
    ...MODELS_FIRST_RUN(),
    ["Set up any integrations now?", []],
  ]);

  const code = await runSetup(
    home,
    p,
    makeOptions({ service: true, waitMs: 50, log: (s) => logs.push(s) }),
  );

  expect(code).toBe(0);
  p.done();
  expect(logs).toContain("japa didn't answer within 30 s; see: japa service logs");
});

test("a rerun with Done changes nothing", async () => {
  const home = tempHome();
  await seedModels(home);
  const beforeSettings = readFileSync(join(home, "settings.json"), "utf8");
  const beforeKey = readFileSync(secretFile(home, "anthropic.apiKey"), "utf8");

  const p = scripted([["What would you like to change?", "Done"]]);
  const code = await runSetup(home, p, makeOptions());

  expect(code).toBe(0);
  p.done();
  expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(beforeSettings);
  expect(readFileSync(secretFile(home, "anthropic.apiKey"), "utf8")).toBe(beforeKey);
});

test("a rerun that saved restarts an active service: systemctl --user restart japa", async () => {
  const home = tempHome();
  await seedModels(home);

  const { exec, calls } = fakeExec((cmd, args) => (args.includes("is-active") ? { code: 0, stdout: "active\n" } : {}));
  const env = makeServiceEnv({ exec });
  mkdirSync(dirname(unitPath(env)), { recursive: true });
  writeFileSync(unitPath(env), "placeholder");

  const p = scripted([
    ["What would you like to change?", "Models"],
    ["Which AI provider", "anthropic"],
    ["How should japa connect", pick("Keep the current API key")],
    ["Which model", first()],
    ["too?", true],
    ["What would you like to change?", "Done"],
  ]);

  const code = await runSetup(home, p, makeOptions({ serviceEnv: env }));

  expect(code).toBe(0);
  p.done();
  expect(calls).toContainEqual({ cmd: "systemctl", args: ["--user", "restart", "japa"] });
});

test("non-interactive with env vars writes models.cos and returns 0", async () => {
  const home = tempHome();
  const probe = await openSetupContext(home, [REPO_EXTENSIONS]);
  const modelId = probe.models.getModels("anthropic")[0]!.id;

  const code = await runSetup(
    home,
    undefined,
    makeOptions({
      interactive: false,
      env: { JAPA_PROVIDER: "anthropic", JAPA_MODEL: modelId, JAPA_API_KEY: "  sk-env\n" },
    }),
  );

  expect(code).toBe(0);
  expect(readSettings(home).models.cos).toEqual({ provider: "anthropic", modelId });
  expect(readFileSync(secretFile(home, "anthropic.apiKey"), "utf8")).toBe("sk-env");
});

test("non-interactive without env vars returns 1 and logs what is missing", async () => {
  const home = tempHome();
  const logs: string[] = [];

  const code = await runSetup(
    home,
    undefined,
    makeOptions({ interactive: false, log: (s) => logs.push(s) }),
  );

  expect(code).toBe(1);
  expect(logs).toContain("missing: models.cos (set JAPA_PROVIDER and JAPA_MODEL, or run japa setup in a terminal)");
  expect(readSetupJson(home).offered).toHaveProperty("telegram");
});

test("--whats-new lists a new fixture extension, configures it when picked, and stays quiet the second time", async () => {
  const home = tempHome();
  const baseline = await openSetupContext(home, [REPO_EXTENSIONS]);
  markOffered(home, baseline.extensions); // the packaged extensions already offered: only fixture is new
  writeFixture(home);

  const logs: string[] = [];
  const p = scripted([
    ["Set up any integrations now?", picks("fixture")],
    ["Fixture token", "tok-1"],
  ]);

  const code = await runSetup(
    home,
    p,
    makeOptions({ whatsNew: true, extensionDirs: [REPO_EXTENSIONS, join(home, "extensions")], log: (s) => logs.push(s) }),
  );

  expect(code).toBe(0);
  p.done();
  expect(logs.some((l) => l.includes("fixture") && l.includes("needs"))).toBe(true);
  expect(readFileSync(secretFile(home, "fixture.token"), "utf8")).toBe("tok-1");

  const logs2: string[] = [];
  const p2 = scripted([]);
  const code2 = await runSetup(
    home,
    p2,
    makeOptions({ whatsNew: true, extensionDirs: [REPO_EXTENSIONS, join(home, "extensions")], log: (s) => logs2.push(s) }),
  );

  expect(code2).toBe(0);
  p2.done();
  expect(logs2).toEqual([]);
});

test("--whats-new lists a new extension with nothing to configure by its summary, once", async () => {
  const home = tempHome();
  markOffered(home, (await openSetupContext(home, [REPO_EXTENSIONS])).extensions);
  writePlain(home);
  const extensionDirs = [REPO_EXTENSIONS, join(home, "extensions")];

  const logs: string[] = [];
  const code = await runSetup(home, undefined, makeOptions({ interactive: false, whatsNew: true, extensionDirs, log: (s) => logs.push(s) }));

  expect(code).toBe(0);
  expect(logs).toEqual(["New extension: plain — Plain extension for setup tests"]); // nothing to run `japa setup` for
  expect(readSetupJson(home).offered.plain).toEqual([]);

  const again: string[] = [];
  await runSetup(home, undefined, makeOptions({ interactive: false, whatsNew: true, extensionDirs, log: (s) => again.push(s) }));
  expect(again).toEqual([]);
});

test("--whats-new doesn't offer to configure an extension with nothing to configure", async () => {
  const home = tempHome();
  markOffered(home, (await openSetupContext(home, [REPO_EXTENSIONS])).extensions);
  writePlain(home);

  const p = scripted([]); // no "Set up any integrations now?"
  const code = await runSetup(home, p, makeOptions({ whatsNew: true, extensionDirs: [REPO_EXTENSIONS, join(home, "extensions")] }));

  expect(code).toBe(0);
  p.done();
});

test("--whats-new works when models.cos is unset and does not prompt for models", async () => {
  const home = tempHome();
  writeFixture(home);

  const p = scripted([
    ["Set up any integrations now?", []], // had this been a model question, the test would fail on the mismatch
  ]);

  const code = await runSetup(
    home,
    p,
    makeOptions({ whatsNew: true, extensionDirs: [REPO_EXTENSIONS, join(home, "extensions")] }),
  );

  expect(code).toBe(0);
  p.done(); // the script has no model steps: a model prompt would have failed to match
  expect(readSetupJson(home).offered).toHaveProperty("fixture");
  expect(existsSync(join(home, "settings.json"))).toBe(false); // declined, and nothing else writes it
});
