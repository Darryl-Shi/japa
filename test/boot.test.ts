import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { envApiKeyAuth, fauxAssistantMessage, fauxText, getSystemMessageText } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { Module } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test, vi } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { ensureClone } from "../src/kernel/jobs/clone.ts";
import { type Job, JobsDoc } from "../src/kernel/jobs/state.ts";
import { statusText } from "../src/kernel/status.ts";
import { commit, ensureWorkspace } from "../src/kernel/workspace.ts";
import { bootErrors, bootTest, REPO_EXTENSIONS, tempHome, testKit, waitFor } from "./helpers.ts";
import { tool } from "./jobs-helpers.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const git = (home: string, ...args: string[]) =>
  execFileSync("git", ["-C", home, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Writes `text` to `path` in `home`, making its folders. */
function write(home: string, path: string, text: string) {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), text);
}

test("the CoS answers in the root conversation", async () => {
  const { daemon, faux } = await bootTest();
  faux.setResponses([fauxAssistantMessage([fauxText("Hello!")])]);
  const settled = await (await daemon.root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  expect(settled.status).toBe("done");
  await daemon.close();
});

test("the identity section reaches the model", async () => {
  const { daemon, faux } = await bootTest();
  let systemPrompt = "";
  faux.setResponses([
    (context) => {
      // pi-ai carries the prompt in system messages, which Pi Durable places positionally in the transcript
      systemPrompt = context.messages.map((m) => (m.role === "system" ? getSystemMessageText(m) : "")).join("\n");
      return fauxAssistantMessage([fauxText("ok")]);
    },
  ]);
  await (await daemon.root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  expect(systemPrompt).toContain("chief of staff");
  await daemon.close();
});

// Jobs can write there: a dependency's missing optional `require` mustn't load code from it (see narrowRequire's test).
test("boot narrows require's global folders to Node's lib/node: no ~/.node_modules, NODE_PATH", async () => {
  const home = process.env.HOME;
  const { daemon } = await bootTest();
  // `_initPaths` refreshes this copy of the folders `require` uses.
  const { globalPaths } = Module as unknown as { globalPaths: string[] };
  expect(globalPaths).toEqual([resolve(dirname(process.execPath), "..", "lib", "node")]);
  expect(process.env.NODE_PATH).toBeUndefined();
  expect(process.env.HOME).toBe(home);
  await daemon.close();
});

test("missing models.cos is one clear error", async () => {
  await expect(boot({ home: tempHome({}) })).rejects.toThrow(/^Set models\.cos in .*settings\.json/);
});

test("unknown model is one clear error", async () => {
  await expect(bootTest({ models: { cos: { provider: "faux", modelId: "nope" } } })).rejects.toThrow(
    "Unknown model faux/nope",
  );
});

test("unknown consolidation model is one clear error", async () => {
  const kit = testKit();
  const models = { cos: kit.model, consolidation: { provider: "faux", modelId: "nope" } };
  const home = tempHome({ storage: { adapter: "memory" }, models });
  await expect(boot({ home, extensions: [kit.extension] })).rejects.toThrow("Unknown model faux/nope");
});

test("missing adapters are clear errors", async () => {
  const kit = testKit();
  const extensions = [kit.extension];
  await expect(boot({ home: tempHome({ storage: { adapter: "nope" } }), extensions })).rejects.toThrow(
    'No storage adapter "nope" is installed',
  );
  await expect(boot({ home: tempHome({ secrets: { adapter: "nope" } }), extensions })).rejects.toThrow(
    'No secrets adapter "nope" is installed',
  );
});

test("boot releases the lock when it fails", async () => {
  const home = tempHome({});
  await expect(boot({ home })).rejects.toThrow();
  expect(existsSync(join(home, "daemon.lock"))).toBe(false);
});

test("status lists the model and the extensions", async () => {
  const { daemon } = await bootTest();
  const status = daemon.status();
  expect(status.model).toEqual({ provider: "faux", modelId: "faux-1" });
  expect(status.extensions).toContainEqual({
    name: "test-kit",
    summary: "Faux models and in-memory storage for tests",
    provides: ["storage", "provider"],
    state: "on",
  });
  expect(status.extensions.map((e) => e.name)).toContain("providers");
  expect(bootErrors(daemon)).toEqual([]);
  await daemon.close();
});

test("an extension's status line is shown under it, read each time", async () => {
  let line = "starting";
  const { daemon } = await bootTest({}, [{ name: "lit", summary: "Lit", status: () => line }]);
  expect(daemon.status().extensions).toContainEqual({ name: "lit", summary: "Lit", provides: [], status: "starting", state: "on" });
  line = "ready";
  expect(statusText(daemon.status())).toContain("  lit — Lit\n    ready");
  await daemon.close();
});

test("a throwing status line is reported, not thrown", async () => {
  const { daemon } = await bootTest({}, [{ name: "bad", summary: "Bad", status: () => { throw new Error("boom"); } }]);
  expect(daemon.status().extensions).toContainEqual({ name: "bad", summary: "Bad", provides: [], status: "status: boom", state: "on" });
  await daemon.close();
});

test("workspace extensions load from <home>/extensions; a broken one is reported", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  const write = (name: string, body: string) => {
    mkdirSync(join(home, "extensions", name), { recursive: true });
    writeFileSync(join(home, "extensions", name, "index.ts"), body);
  };
  write(
    "ws-good",
    `import { defineJapaExtension } from "japa/sdk";\n` +
      `export default defineJapaExtension({ name: "ws-good", summary: "Good" });\n`,
  );
  write("ws-broken", `throw new Error("boom");\n`);
  const daemon = await boot({ home, extensions: [kit.extension] });
  expect(daemon.status().extensions.map((e) => e.name)).toContain("ws-good");
  expect(bootErrors(daemon).map((e) => e.name)).toEqual(["ws-broken"]);
  await daemon.close();
});

test("history survives a restart on sqlite", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // default storage: sqlite
  let d = await boot({ home, extensions: [kit.extension] });
  kit.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
  await (await d.root.submit({ type: "input", content: "remember me" }, ctx)).wait(ctx);
  await d.close();
  d = await boot({ home, extensions: [kit.extension] });
  const page = await d.root.entries({}, 100, undefined, ctx);
  expect(JSON.stringify(page.items)).toContain("remember me");
  await d.close();
});

test("a CoS model whose provider has no key is reported, naming the env var and the secrets file", async () => {
  const kit = testKit();
  const provider = { ...kit.faux.provider, auth: { apiKey: envApiKeyAuth("Test", ["JAPA_TEST_API_KEY"]) } };
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  const extension = { ...kit.extension, provides: { ...kit.extension.provides, provider: [provider] } };
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [extension] });
  const file = join(home, "secrets", `${kit.model.provider}.apiKey`);
  expect(bootErrors(daemon)).toEqual([
    {
      name: "models",
      error:
        `No credentials for ${kit.model.provider}. Run japa setup to sign in or add an API key, ` +
        `or set JAPA_TEST_API_KEY or write the key to ${file}, then restart.`,
    },
  ]);
  await daemon.close();
});

// Review Focus 4: a daemon that died mid-merge leaves conflict markers in the working tree; they must not load, nor be
// adopted.
test("boot aborts an unfinished merge", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  write(home, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\nbase\n");
  commit(home, ["skills"], "base");
  git(home, "checkout", "-q", "-b", "job");
  write(home, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\njob\n");
  commit(home, ["skills"], "job");
  git(home, "checkout", "-q", "main");
  write(home, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\nmain\n");
  const installed = commit(home, ["skills"], "main");
  expect(() => git(home, "merge", "job")).toThrow();
  expect(existsSync(join(home, ".git", "MERGE_HEAD"))).toBe(true);

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(existsSync(join(home, ".git", "MERGE_HEAD"))).toBe(false);
  expect(git(home, "rev-parse", "HEAD")).toBe(installed);
  expect(readFileSync(join(home, "skills", "s", "SKILL.md"), "utf8")).toContain("main");
  expect(git(home, "status", "--porcelain", "--", "skills")).toBe("");
  await daemon.close();
});

test("boot aborts an unfinished merge before committing .gitignore's new lines", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  // As an older japa left it: without a line japa now ignores.
  write(home, ".gitignore", readFileSync(join(home, ".gitignore"), "utf8").replace("/.jobs/\n", ""));
  commit(home, [".gitignore"], "older");
  git(home, "checkout", "-q", "-b", "job");
  write(home, "skills/s/SKILL.md", "job\n");
  commit(home, ["skills"], "job");
  git(home, "checkout", "-q", "main");
  write(home, "skills/s/SKILL.md", "main\n");
  const installed = commit(home, ["skills"], "main");
  expect(() => git(home, "merge", "job")).toThrow();

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(existsSync(join(home, ".git", "MERGE_HEAD"))).toBe(false);
  expect(git(home, "log", "-1", "--format=%s")).toBe("Update .gitignore");
  expect(git(home, "rev-parse", "HEAD^")).toBe(installed);
  expect(git(home, "show", "HEAD:.gitignore").split("\n")).toContain("/.jobs/");
  expect(git(home, "status", "--porcelain", "--", ".gitignore", "skills")).toBe("");
  await daemon.close();
});

test("boot commits a .gitignore edited by hand but not committed", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  write(home, ".gitignore", `${readFileSync(join(home, ".gitignore"), "utf8")}scratch/\n`);

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(git(home, "log", "-1", "--format=%s")).toBe("Update .gitignore");
  expect(git(home, "show", "HEAD:.gitignore").split("\n")).toContain("scratch/");
  expect(git(home, "status", "--porcelain", "--", ".gitignore")).toBe("");
  await daemon.close();
});

test("boot removes a stale .git/index.lock first, says so, and commits", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  const lock = join(home, ".git", "index.lock");
  writeFileSync(lock, ""); // a git that died mid-write, 11 s ago
  const stale = (Date.now() - 11_000) / 1000;
  utimesSync(lock, stale, stale);
  write(home, "skills/hand/SKILL.md", "---\nname: hand\ndescription: By hand\n---\nDo it.\n");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(existsSync(join(home, ".git", "index.lock"))).toBe(false);
  expect(errors).toHaveBeenCalledWith(`Removed a stale ${join(home, ".git", "index.lock")} left by a git that stopped`);
  expect(git(home, "log", "-1", "--format=%s")).toBe("Edits made outside japa");
  expect(daemon.status().errors.filter((e) => e.name === "workspace")).toEqual([]);
  await daemon.close();
});

test("boot leaves an index.lock under 10 s old, which a git may still hold, and reports it", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  const lock = join(home, ".git", "index.lock");
  writeFileSync(lock, "");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(existsSync(lock)).toBe(true);
  expect(daemon.status().errors.filter((e) => e.name === "workspace")).toEqual([
    {
      name: "workspace",
      error: `Left ${lock}: it's under 10 seconds old, so a git may still be using it. If it stays, restart japa to remove it`,
    },
  ]);
  await daemon.close();
});

test("boot logs adopted edits as a change", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  write(home, "skills/hand/SKILL.md", "---\nname: hand\ndescription: By hand\n---\nDo it.\n");
  write(home, "settings.json", readFileSync(join(home, "settings.json"), "utf8")); // unchanged
  write(home, "notes.txt", "not japa's\n");

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(git(home, "log", "-1", "--format=%s")).toBe("Edits made outside japa");
  expect(git(home, "show", "--name-only", "--format=", "HEAD")).toBe("skills/hand/SKILL.md");
  expect(git(home, "status", "--porcelain", "--", "skills", "notes.txt")).toBe("?? notes.txt");
  expect(await tool(daemon, kit.faux, "changes_list")).toMatch(/Edits made outside japa/);
  await daemon.close();
});

test("boot retires the staging worktree, archiving it", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  git(home, "worktree", "add", "-q", "-B", "staging", ".staging", "main");
  write(home, ".staging/skills/draft/SKILL.md", "draft");

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(existsSync(join(home, ".staging"))).toBe(false);
  expect(git(home, "branch", "--list", "staging")).toBe("");
  const archived = join(home, ".jobs", "staging-archive", ".staging", "skills", "draft", "SKILL.md");
  expect(readFileSync(archived, "utf8")).toBe("draft");
  await daemon.close();
});

test("boot reports a staging worktree it can't retire, and still adopts edits", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  git(home, "worktree", "add", "-q", "-B", "staging", ".staging", "main");
  mkdirSync(join(home, ".jobs"), { mode: 0o500 });
  onTestFinished(() => chmodSync(join(home, ".jobs"), 0o700));
  write(home, "skills/hand/SKILL.md", "---\nname: hand\ndescription: By hand\n---\nDo it.\n");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(daemon.status().errors).toContainEqual({
    name: "workspace",
    error: expect.stringMatching(/^Couldn't retire the old staging worktree /),
  });
  expect(git(home, "log", "-1", "--format=%s")).toBe("Edits made outside japa");
  await daemon.close();
});

test("boot prunes the clones and job refs of jobs that aren't active, keeping active ones whatever their age", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // sqlite: the jobs outlive the first boot
  let daemon = await boot({ home, extensions: [kit.extension] });
  const now = Date.now();
  const job = (id: string, status: Job["status"]) =>
    ({ id, title: id, brief: "", status, conversationId: 1_000_000 + Number(id), createdAt: now, updatedAt: now, seq: 0, reported: [] }) as unknown as Job; // conversations long gone
  await daemon.root.commit(async (tx) => {
    const doc = await tx.doc(JobsDoc, daemon.root.id);
    doc.jobs["1"] = job("1", "needs_input");
    doc.jobs["2"] = job("2", "done");
  }, ctx);
  await daemon.close();
  const jobs = join(home, ".jobs");
  for (const id of ["1", "2", "3"]) {
    ensureClone(home, packageRoot, id);
    git(home, "update-ref", `refs/japa/jobs/${id}`, "HEAD");
  }
  const old = (now - 30 * 86_400_000) / 1000;
  utimesSync(join(jobs, "1"), old, old);

  daemon = await boot({ home, extensions: [kit.extension] });
  expect(readdirSync(jobs).sort()).toEqual(["1", "1.base", "1.tmp", "2", "2.base", "2.tmp"]);
  expect(git(home, "for-each-ref", "--format=%(refname)", "refs/japa")).toBe("refs/japa/jobs/1");
  await daemon.close();
});

test("boot goes on when pruning fails, and reports it", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  for (const id of ["1", "2"]) git(home, "update-ref", `refs/japa/jobs/${id}`, "HEAD");
  writeFileSync(join(home, ".git", "refs", "japa", "jobs", "1.lock"), ""); // a git that stopped mid-update
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());

  let daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(daemon.status().errors).toContainEqual({
    name: "workspace",
    error: expect.stringMatching(/^Couldn't delete refs\/japa\/jobs\/1: /),
  });
  expect(git(home, "for-each-ref", "--format=%(refname)", "refs/japa")).toBe("refs/japa/jobs/1");
  await daemon.close();

  // The clones can't even be listed.
  mkdirSync(join(home, ".jobs"), { mode: 0o000 });
  onTestFinished(() => chmodSync(join(home, ".jobs"), 0o700));
  daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(daemon.status().errors).toContainEqual({
    name: "workspace",
    error: expect.stringMatching(/^Couldn't prune finished jobs: .*EACCES/),
  });
  await daemon.close();
});

test("each prune replaces the errors of the one before: a later one that succeeds clears them", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  git(home, "update-ref", "refs/japa/jobs/1", "HEAD");
  const lock = join(home, ".git", "refs", "japa", "jobs", "1.lock");
  writeFileSync(lock, "");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => logged.mockRestore());
  const intervals = vi.spyOn(globalThis, "setInterval");
  onTestFinished(() => intervals.mockRestore());

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  const failure = { name: "workspace", error: expect.stringMatching(/^Couldn't delete refs\/japa\/jobs\/1: /) };
  const workspaceErrors = () => daemon.status().errors.filter((e) => e.name === "workspace");
  expect(workspaceErrors()).toEqual([failure]);
  const hourly = intervals.mock.calls.find(([, ms]) => ms === 3_600_000)![0] as () => void;
  const failures = () => logged.mock.calls.filter(([text]) => String(text).startsWith("Couldn't delete")).length;
  const before = failures();
  hourly(); // fails again: one error still, not two
  await waitFor(() => failures() > before);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(workspaceErrors()).toEqual([failure]);
  rmSync(lock);
  hourly();
  await waitFor(() => workspaceErrors().length === 0);
  expect(git(home, "for-each-ref", "refs/japa")).toBe("");
  await daemon.close();
});

test("boot survives a stored unfinished job without a conversation", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } });
  let daemon = await boot({ home, extensions: [kit.extension] });
  await daemon.root.commit(async (tx) => {
    const doc = await tx.doc(JobsDoc, daemon.root.id);
    doc.jobs["1"] = { id: "1", title: "1", brief: "", status: "running", createdAt: 0, updatedAt: 0, seq: 0, reported: [] } as unknown as Job;
  }, ctx);
  await daemon.close();

  daemon = await boot({ home, extensions: [kit.extension] }); // used to throw
  let status: string | undefined;
  await daemon.root.commit(async (tx) => {
    status = (await tx.doc(JobsDoc, daemon.root.id)).jobs["1"]?.status;
  }, ctx);
  expect(status).toBe("running");
  await daemon.close();
});

// A .staging moved here, or whose worktree record is gone: its git fails, which mustn't stop boot.
test("boot retires a .staging whose worktree record is gone", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  git(home, "worktree", "add", "-q", "-B", "staging", ".staging", "main");
  write(home, ".staging/skills/draft/SKILL.md", "draft");
  rmSync(join(home, ".git", "worktrees"), { recursive: true });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(existsSync(join(home, ".staging"))).toBe(false);
  const archived = join(home, ".jobs", "staging-archive", ".staging", "skills", "draft", "SKILL.md");
  expect(readFileSync(archived, "utf8")).toBe("draft");
  expect(git(home, "branch", "--list", "staging")).toBe("");
  await daemon.close();
});

test("boot goes on when the workspace can't be tidied, adopting nothing, and reports it", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  write(home, "skills/hand/SKILL.md", "---\nname: hand\ndescription: By hand\n---\nDo it.\n");
  mkdirSync(join(home, ".git", "rebase-merge")); // a rebase git can't abort
  const before = git(home, "rev-parse", "HEAD");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(git(home, "rev-parse", "HEAD")).toBe(before);
  expect(daemon.status().errors).toContainEqual({
    name: "workspace",
    error: expect.stringMatching(
      /^Couldn't finish tidying the workspace: the rebase in progress couldn't be aborted: .*The repo is still mid-rebase, so edits made outside japa weren't adopted; if it's aborted by hand later, the commits japa makes until then may be lost\.$/s,
    ),
  });
  await daemon.close();
});
