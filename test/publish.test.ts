import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { Change } from "../src/kernel/changes.ts";
import { ensureClone } from "../src/kernel/jobs/clone.ts";
import { linkSdk } from "../src/kernel/loader.ts";
import { publishable } from "../src/kernel/jobs/narrow.ts";
import { createPublisher, type PublishDeps, reportingFailures, sandboxCheck } from "../src/kernel/jobs/publish.ts";
import { loadSkills, skillAt } from "../src/kernel/skills.ts";
import { jobEnv, runSandboxed, type SandboxSpec } from "../src/kernel/sandbox/bwrap.ts";
import { createJobSandboxes } from "../src/kernel/sandbox/jobs.ts";
import { createWorkspaceLock } from "../src/kernel/workspace-lock.ts";
import { ensureWorkspace } from "../src/kernel/workspace.ts";
import { NO_BWRAP, sandboxScratch, waitFor } from "./helpers.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** The test's own git: it inspects the real repo, and acts as the job in its clone. */
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=job", "-c", "user.email=job@localhost", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

const SETTINGS = '{"a":1}\n';
const INDEX = "line 1\nline 2\n";

/**
 * A workspace (in a scratch dir outside `/tmp`, which jobs see replaced by their own) holding `settings.json`,
 * `extensions/e/index.ts` and `extensions/e/a.ts`, plus `files`; `HOME` is a scratch user dir until the test finishes.
 * The workspace is its `.japa`, or with `o.away` a folder outside it; with `o.unlinked`, its `package.json` (which
 * `linkSdk` writes) isn't committed. Job 1's clone of it, as its first tool call makes it, and the job sandboxes, whose
 * spec runs the publisher's git.
 */
function setup(files: Record<string, string> = {}, o: { away?: boolean; unlinked?: boolean } = {}) {
  const outside = sandboxScratch("japa-publish-");
  const user = join(outside, "user");
  const home = o.away ? join(outside, "home") : join(user, ".japa");
  mkdirSync(home, { recursive: true });
  mkdirSync(user, { recursive: true });
  const base = { "settings.json": SETTINGS, "extensions/e/index.ts": INDEX, "extensions/e/a.ts": "a\n", ...files };
  for (const [path, text] of Object.entries(base)) write(home, path, text);
  if (!o.unlinked) linkSdk(home, packageRoot); // as boot does, first: its package.json is committed
  ensureWorkspace(home);
  const saved = process.env.HOME;
  process.env.HOME = user;
  const nodeLib = join(outside, "prefix", "lib", "node");
  mkdirSync(dirname(nodeLib), { recursive: true });
  const sandboxes = createJobSandboxes({ home, packageRoot, hidden: [], env: jobEnv(), nodeLib });
  onTestFinished(() => {
    sandboxes.closeAll();
    process.env.HOME = saved;
    rmSync(outside, { recursive: true, force: true });
  });
  const clone = ensureClone(home, packageRoot, "1");
  return { outside, home, clone, sandboxes, base: git(home, "rev-parse", "HEAD") };
}

/**
 * A publisher for `home` with fakes: `check` passes, `reconcile` finds no errors and there are none, a skill is loaded
 * when its folder exists, and changes get ids from 1. `calls` records them.
 */
function publisher(home: string, spec: (jobId: string) => SandboxSpec, o: Partial<PublishDeps> = {}) {
  const calls = { check: [] as string[], changes: [] as Omit<Change, "id" | "at">[], reconciles: 0, good: 0 };
  const publish = createPublisher({
    home,
    packageRoot,
    lock: createWorkspaceLock(),
    spec,
    check: async (jobId, kind, name) => {
      calls.check.push(`${jobId}:${kind}s/${name}`);
      return [];
    },
    reconcile: async () => {
      calls.reconciles++;
      return { errors: [] };
    },
    errors: () => [],
    loaded: (kind, name) => existsSync(join(home, `${kind}s`, name)),
    logChange: async (change) => {
      calls.changes.push(change);
      return String(calls.changes.length);
    },
    scheduleGood: () => void calls.good++,
    ...o,
  });
  return { publish, calls };
}

/** The real git on the host, for a stand-in `git` to call. */
const realGit = () => execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/**
 * A spec whose sandbox finds a stand-in `git` first on its PATH, as a job can put one in a folder of its PATH it can
 * write: it runs `before` (sh, in the clone) ahead of `git bundle`, then the real git, then `after`.
 */
function withGit(outside: string, spec: (jobId: string) => SandboxSpec, before: string, after = ":") {
  const bin = join(outside, "bin");
  mkdirSync(bin, { recursive: true });
  const script = [
    "#!/bin/sh",
    'bundle=; for a in "$@"; do [ "$a" = bundle ] && bundle=1; done',
    `if [ -n "$bundle" ]; then ${before}; fi`,
    `${realGit()} "$@" || exit $?`,
    `if [ -n "$bundle" ]; then ${after}; fi`,
  ].join("\n");
  writeFileSync(join(bin, "git"), `${script}\n`, { mode: 0o755 });
  return (jobId: string): SandboxSpec => {
    const s = spec(jobId);
    return { ...s, env: { ...s.env, PATH: `${bin}:${s.env.PATH ?? "/usr/bin:/bin"}` } };
  };
}

/**
 * Whether `fallocate --keep-size` allocates blocks past a file's end where the sandbox tests' scratch dirs are (and a
 * job's /tmp with them): not every filesystem can.
 */
const FALLOCATE = (() => {
  const dir = sandboxScratch("japa-fallocate-");
  try {
    const file = join(dir, "probe");
    writeFileSync(file, "x");
    execFileSync("fallocate", ["--keep-size", "-l", "2M", file], { stdio: "ignore" });
    return statSync(file).blocks * 512 >= 2 * 1024 * 1024;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const KEPT = "Kept at ~/.japa/.jobs/1.";
const job = { id: "1", title: "t", seq: 1 };

describe.skipIf(NO_BWRAP)("publish", () => {
  test("nothing changed: undefined, clone deleted; a job without a clone: undefined", async () => {
    const { home, clone, sandboxes, base } = setup();
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBeUndefined();
    expect(existsSync(clone)).toBe(false);
    expect(["1.base", "1.tmp", "1.merged"].filter((name) => existsSync(join(home, ".jobs", name)))).toEqual([]);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(calls).toMatchObject({ changes: [], check: [], reconciles: 0 });
    // Job 2 never made a tool call, so it has no clone.
    expect(await publish({ id: "2", title: "t", seq: 1 })).toBeUndefined();
  });

  test("only changes outside the components: not live, the dropped paths named, the clone kept, the real tree unchanged", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(clone, "README.md", "r\n");
    write(clone, "notes.md", "n\n");
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe(
      `Not live: the job changed nothing under extensions/ or skills/. ${KEPT} Dropped: README.md, notes.md.`,
    );
    expect(existsSync(clone)).toBe(true);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(read(home, "settings.json")).toBe(SETTINGS);
    expect(calls).toMatchObject({ changes: [], check: [], reconciles: 0 });
  });

  test("every Not live line names the dropped paths too", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    write(clone, "README.md", "r\n");
    const { publish } = publisher(home, sandboxes.spec, { check: async () => ["boom"] });
    expect(await publish(job)).toBe(`Not live: check failed for extensions/e: boom. ${KEPT} Dropped: README.md.`);
  });

  test("a reverted load names the dropped paths, after a restart too", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "broken\n");
    write(clone, "notes.md", "n\n");
    const { publish } = publisher(home, sandboxes.spec, {
      reconcile: async () => ({ errors: [{ name: "e", error: "bad" }] }),
    });
    const line = `Not live: extensions/e failed to load: bad. Reverted. ${KEPT} Dropped: notes.md.`;
    expect(await publish(job)).toBe(line);
    expect(await publish(job)).toBe(line);
  });

  test("an extension and a skill go live in one merge", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "line 1 changed\nline 2\n");
    write(clone, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\n");
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e, skills/s (change 1).");
    const merge = git(home, "rev-parse", "HEAD");
    expect(git(home, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toEqual([merge, base, expect.any(String)]);
    expect(git(home, "log", "-1", "--format=%s|%an <%ae>", "HEAD")).toBe("Job 1: t|japa <japa@localhost>");
    expect(git(home, "log", "-1", "--format=%s|%an <%ae>", "HEAD^2")).toBe("Job 1: t|japa <japa@localhost>");
    expect(read(home, "extensions/e/index.ts")).toBe("line 1 changed\nline 2\n");
    expect(read(home, "skills/s/SKILL.md")).toContain("name: s");
    expect(calls.check).toEqual(["1:extensions/e", "1:skills/s"]);
    expect(calls.changes).toEqual([
      { title: "Job 1: changed extensions/e, skills/s", howToUse: "", undo: { commits: [merge] } },
    ]);
    expect(calls).toMatchObject({ reconciles: 1, good: 1 });
    expect(git(home, "status", "--porcelain")).toBe("");
    // Done with: the clone, its files next to it, and the fetched ref.
    expect(existsSync(clone)).toBe(false);
    expect(["1.base", "1.tmp", "1.merged"].filter((name) => existsSync(join(home, ".jobs", name)))).toEqual([]);
    expect(git(home, "for-each-ref", "refs/japa")).toBe("");
  });

  test("a job sees the real settings.json, so its clone's differing isn't a change of the job's", async () => {
    const { home, clone, sandboxes } = setup();
    write(home, "settings.json", '{"local":true}\n'); // the settings tools write it at any time
    write(clone, "settings.json", '{"a":2}\n'); // hidden in the sandbox under the real one
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    expect(read(home, "settings.json")).toBe('{"local":true}\n');
    expect(git(home, "show", "HEAD^2:settings.json")).toBe(SETTINGS.trim());
    expect(read(home, "extensions/e/index.ts")).toBe("changed\n");
  });

  test("a new file outside the components is dropped and reported", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "README.md", "r\n");
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1). Dropped: README.md.");
    expect(existsSync(join(home, "README.md"))).toBe(false);
  });

  test("files changed, removed or new outside the components are reported; the shared folder's and linkSdk's aren't", async () => {
    // The real tree has no package.json committed: the clone's is the one ensureClone's linkSdk made.
    const { home, clone, sandboxes } = setup({ "notes.md": "n\n" }, { unlinked: true });
    expect(read(clone, "package.json")).toBe('{"type":"module"}\n');
    // The real shared folder, which the sandbox mounts in the clone. The job un-ignores it, and node_modules.
    write(home, "desktop/shared/shot.png", "png");
    const ignored = read(clone, ".gitignore").split("\n");
    write(clone, ".gitignore", ignored.filter((line) => line !== "/desktop/" && line !== "node_modules/").join("\n"));
    rmSync(join(clone, "notes.md"));
    write(clone, "new.md", "new\n");
    write(clone, ".cache/junk", "j"); // still ignored: never staged
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1). Dropped: .gitignore, new.md, notes.md.");
    expect(read(home, "notes.md")).toBe("n\n");
    expect(existsSync(join(home, "new.md"))).toBe(false);
    expect(read(home, "desktop/shared/shot.png")).toBe("png");
    expect(git(home, "status", "--porcelain")).toBe("");
  });

  test("files under node_modules/japa are reported: only the link itself is linkSdk's", async () => {
    const { home, clone, sandboxes } = setup();
    const ignored = read(clone, ".gitignore").split("\n");
    write(clone, ".gitignore", ignored.filter((line) => line !== "node_modules/").join("\n"));
    rmSync(join(clone, "node_modules", "japa"));
    write(clone, "node_modules/japa/x.js", "x\n");
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1). Dropped: .gitignore, node_modules/japa/x.js.");
  });

  test("a package.json the job wrote is reported", async () => {
    const { home, clone, sandboxes } = setup({}, { unlinked: true });
    write(clone, "package.json", '{"type":"module","dependencies":{"x":"1"}}\n');
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1). Dropped: package.json.");
    expect(existsSync(join(home, "package.json"))).toBe(false);
  });

  test("git files and odd paths in a component are dropped like paths outside them", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/.gitattributes", "* filter=evil\n");
    write(clone, "skills/s/.LFSConfig", "[lfs]\n");
    write(clone, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\n");
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe(
      "Live: extensions/e, skills/s (change 1). Dropped: extensions/e/.gitattributes, skills/s/.LFSConfig.",
    );
    expect(existsSync(join(home, "extensions", "e", ".gitattributes"))).toBe(false);
    expect(existsSync(join(home, "skills", "s", ".LFSConfig"))).toBe(false);
  });

  test("publishable: in a component, with no ., .. or .git folder, nor a git file", () => {
    for (const path of ["extensions/e/index.ts", "skills/s/SKILL.md", "skills/s/.gitignore", "extensions/e/a.git"]) {
      expect(publishable(path), path).toBe(true);
    }
    const odd = [
      "settings.json",
      "extensions",
      "extensions/",
      "skills/s/./x",
      "skills/s/../../settings.json",
      "extensions/e/.git/config",
      "extensions/e/.GIT/hooks/x",
      "extensions//x",
      "extensions/e/.gitattributes",
      "skills/s/sub/.GitAttributes",
      "skills/s/.lfsconfig",
      "extensions/e/.gitmodules",
      "extensions/.gitmodules",
    ];
    for (const path of odd) expect(publishable(path), path).toBe(false);
  });

  test("a job's own commit to settings.json can't sneak through: it is dropped too", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "settings.json", '{"a":2}\n');
    write(clone, "extensions/e/index.ts", "changed\n");
    git(clone, "commit", "-q", "-a", "-m", "the job's own commit");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1). Dropped: settings.json.");
    expect(read(home, "settings.json")).toBe(SETTINGS);
    expect(git(home, "status", "--porcelain")).toBe("");
  });

  test("a job's changes outside the components that get past narrowing are refused in the real repo", async () => {
    const { outside, home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    // The job's git commits a file outside them after narrowing, just before the bundle is made.
    const tamper = [
      "printf 'tampered\\n' > notes.md",
      `${realGit()} add notes.md`,
      `${realGit()} -c core.hooksPath=/dev/null -c user.name=job -c user.email=job@localhost commit -q -m tamper notes.md`,
    ].join(" && ");
    const { publish, calls } = publisher(home, withGit(outside, sandboxes.spec, tamper));
    expect(await publish(job)).toBe(`Not live: the job changed notes.md outside extensions/ and skills/. ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(read(home, "settings.json")).toBe(SETTINGS);
    expect(calls).toMatchObject({ check: [], changes: [], reconciles: 0 });
    expect(existsSync(clone)).toBe(true);
    expect(git(home, "for-each-ref", "refs/japa")).toBe("");
  });

  test("a git file in a component that gets past narrowing is refused in the real repo", async () => {
    const { outside, home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    const tamper = [
      `mkdir -p skills/s && printf '* filter=evil\\n' > skills/s/.GitAttributes`,
      `${realGit()} -c core.hooksPath=/dev/null -c user.name=job -c user.email=job@localhost add skills/s/.GitAttributes`,
      `${realGit()} -c core.hooksPath=/dev/null -c user.name=job -c user.email=job@localhost commit -q -m tamper`,
    ].join(" && ");
    const { publish, calls } = publisher(home, withGit(outside, sandboxes.spec, tamper));
    expect(await publish(job)).toBe(`Not live: the job changed skills/s/.GitAttributes, which japa doesn't publish. ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(calls).toMatchObject({ check: [], changes: [] });
  });

  test("a tag in the job's bundle isn't fetched", async () => {
    const { outside, home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    const tags = git(home, "for-each-ref", "refs/tags");
    const g = realGit();
    const tagged = `${g} tag evil-tag HEAD && ${g} bundle create -q /tmp/publish.bundle HEAD evil-tag ^${base}`;
    const { publish } = publisher(home, withGit(outside, sandboxes.spec, ":", tagged));
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    expect(git(home, "for-each-ref", "refs/tags")).toBe(tags);
  });

  test("a bundle over 100 MB is refused before it's read", async () => {
    const { outside, home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    // Sparse: it takes no room on disk.
    const { publish } = publisher(home, withGit(outside, sandboxes.spec, ":", "truncate -s 101M /tmp/publish.bundle"));
    expect(await publish(job)).toBe(`Not live: the job's changes are too large (over 100 MB). ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(clone)).toBe(true);
  });

  test("a cap under 1 MB is shown in KB or bytes", async () => {
    const { outside, home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    const spec = withGit(outside, sandboxes.spec, ":", "truncate -s 3K /tmp/publish.bundle");
    expect(await publisher(home, spec, { maxBundleBytes: 2048 }).publish(job)).toBe(
      `Not live: the job's changes are too large (over 2 KB). ${KEPT}`,
    );
    expect(await publisher(home, spec, { maxBundleBytes: 100 }).publish(job)).toBe(
      `Not live: the job's changes are too large (over 100 bytes). ${KEPT}`,
    );
  });

  test("narrowing's report with a bad count is a failed commit step", async () => {
    const { outside, home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    // A stand-in for narrow.ts, which prints `report`.
    const fake = join(outside, "fake");
    mkdirSync(join(fake, "src", "kernel", "jobs"), { recursive: true });
    const reports = [
      { dropped: [], bundle: true }, // missing
      { dropped: [], droppedCount: -1, bundle: true },
      { dropped: [], droppedCount: null, bundle: true }, // NaN, as JSON writes it
      { dropped: [], droppedCount: "NaN", bundle: true },
      { dropped: [], droppedCount: 1.5, bundle: true },
      { dropped: ["a", "b"], droppedCount: 1, bundle: true }, // below dropped.length
    ];
    for (const report of reports) {
      const json = JSON.stringify(report);
      writeFileSync(join(fake, "src", "kernel", "jobs", "narrow.ts"), `console.log(${JSON.stringify(json)});\n`);
      const { publish, calls } = publisher(home, sandboxes.spec, { packageRoot: fake });
      expect(await publish(job), json).toBe(`Not live: couldn't commit the job's changes: ${json}. ${KEPT}`);
      expect(calls.check).toEqual([]);
    }
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    // The same, with a good count, goes on to the bundle (none here).
    const good = JSON.stringify({ dropped: ["a", "b"], droppedCount: 2, bundle: true });
    writeFileSync(join(fake, "src", "kernel", "jobs", "narrow.ts"), `console.log(${JSON.stringify(good)});\n`);
    rmSync(join(home, ".jobs", "1.tmp", "publish.bundle"), { force: true });
    const { publish } = publisher(home, sandboxes.spec, { packageRoot: fake });
    expect(await publish(job)).toMatch(/^Not live: couldn't commit the job's changes: ENOENT: .*publish\.bundle/);
  });

  test.skipIf(!FALLOCATE)("a bundle that takes more room on disk than the cap is refused, whatever its size", async () => {
    const { outside, home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    // Blocks allocated past its end (`--keep-size`): its size stays the real bundle's, under the cap.
    const allocate = "fallocate --keep-size -l 2M /tmp/publish.bundle";
    const spec = withGit(outside, sandboxes.spec, ":", allocate);
    const { publish } = publisher(home, spec, { maxBundleBytes: 1024 * 1024 });
    expect(await publish(job)).toBe(`Not live: the job's changes are too large (over 1 MB). ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
  });

  test("a job's commit already in the real history isn't merged as the job's", async () => {
    const { outside, home, clone, sandboxes } = setup();
    // A commit made on main since the job started, which the job hands over as its own.
    write(home, "extensions/e/a.ts", "a fixed\n");
    git(home, "commit", "-q", "-a", "-m", "fix");
    const main = git(home, "rev-parse", "HEAD");
    git(home, "bundle", "create", "-q", join(outside, "main.bundle"), "HEAD^..HEAD");
    write(clone, "extensions/e/index.ts", "changed\n");
    const swap = `cp "${join(outside, "main.bundle")}" /tmp/publish.bundle`;
    const { publish, calls } = publisher(home, withGit(outside, sandboxes.spec, ":", swap));
    expect(await publish(job)).toBe(`Not live: the job's commit is already in ~/.japa. ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(main);
    expect(existsSync(join(home, ".jobs", "1.merged"))).toBe(false);
    expect(calls).toMatchObject({ changes: [], reconciles: 0 });
    expect(git(home, "for-each-ref", "refs/japa")).toBe("");
  });

  test("a job whose changes the real repo has already brings nothing: nothing goes live, and no merge is left", async () => {
    const { home, clone, sandboxes } = setup();
    // The same skill, put in by hand since the job started.
    const SKILL = "---\nname: s\ndescription: S\n---\n";
    write(home, "skills/s/SKILL.md", SKILL);
    git(home, "add", "skills");
    git(home, "commit", "-q", "-m", "by hand");
    const main = git(home, "rev-parse", "HEAD");
    write(clone, "skills/s/SKILL.md", SKILL);
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe(`Not live: the job's changes are already in ~/.japa. ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(main);
    expect(git(home, "status", "--porcelain")).toBe("");
    expect(existsSync(join(home, ".jobs", "1.merged"))).toBe(false);
    expect(calls).toMatchObject({ changes: [], reconciles: 0 });
  });

  test("a bundle the job swapped for a symlink isn't followed", async () => {
    const { outside, home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    // A valid bundle the job can't see (inside, that path is in its own clone), with a component to go live.
    const other = join(outside, "other");
    git(outside, "clone", "-q", home, other);
    write(other, "extensions/evil/index.ts", "evil\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "evil");
    const evil = join(home, ".git", "evil.bundle");
    git(other, "bundle", "create", "-q", evil, `${base}..HEAD`);
    const swap = `ln -sf "${evil}" /tmp/publish.bundle`;
    const { publish } = publisher(home, withGit(outside, sandboxes.spec, ":", swap));
    expect(await publish(job)).toMatch(/^Not live: couldn't commit the job's changes: .+\. Kept at ~\/\.japa\/\.jobs\/1\.$/);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(home, "extensions", "evil"))).toBe(false);
  });

  test("a job whose history doesn't start from its base is refused", async () => {
    const { home, clone, sandboxes, base } = setup();
    git(clone, "checkout", "-q", "--orphan", "other");
    write(clone, "extensions/e/index.ts", "changed\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "unrelated");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe(`Not live: the job's history doesn't start from its base. ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(git(home, "for-each-ref", "refs/japa")).toBe("");
    expect(existsSync(clone)).toBe(true);
  });

  test("a failure to commit in the clone is reported, and nothing changes", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    writeFileSync(join(clone, ".git", "index"), "garbled");
    const { publish } = publisher(home, sandboxes.spec);
    const line = await publish(job);
    expect(line).toMatch(/^Not live: couldn't commit the job's changes: .*index file.*\. Kept at ~\/\.japa\/\.jobs\/1\.$/);
    expect(line).not.toContain("\n");
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(clone)).toBe(true);
  });

  test("a failed check changes nothing", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish, calls } = publisher(home, sandboxes.spec, { check: async () => ["boom"] });
    expect(await publish(job)).toBe(`Not live: check failed for extensions/e: boom. ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(clone)).toBe(true);
    expect(calls).toMatchObject({ changes: [], reconciles: 0 });
    expect(git(home, "for-each-ref", "refs/japa")).toBe("");
  });

  test("a kept clone is named by its real path when the home isn't in the user's home", async () => {
    const { home, clone, sandboxes } = setup({}, { away: true });
    expect(clone).toBe(join(home, ".jobs", "1"));
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec, { check: async () => ["boom"] });
    expect(await publish(job)).toBe(`Not live: check failed for extensions/e: boom. Kept at ${clone}.`);
  });

  test("regression: a fix made since the job started is kept", async () => {
    const { home, clone, sandboxes } = setup();
    write(home, "extensions/e/a.ts", "a fixed\n");
    git(home, "commit", "-q", "-a", "-m", "fix");
    write(clone, "extensions/e/b.ts", "b\n");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    expect(read(home, "extensions/e/a.ts")).toBe("a fixed\n");
    expect(read(home, "extensions/e/b.ts")).toBe("b\n");
  });

  test("a long list of conflicting files is cut at 1,000 characters", async () => {
    // Five files, each of 259 characters: three fit.
    const paths = Array.from({ length: 5 }, (_, i) => `extensions/e/${"x".repeat(240)}/${i}.ts`);
    const { home, clone, sandboxes } = setup(Object.fromEntries(paths.map((path) => [path, INDEX])));
    for (const path of paths) write(home, path, "line 1 main\nline 2\n");
    git(home, "commit", "-q", "-a", "-m", "main");
    for (const path of paths) write(clone, path, "line 1 job\nline 2\n");
    const { publish } = publisher(home, sandboxes.spec);
    const named = paths.slice(0, 3).join(", ");
    expect(await publish(job)).toBe(`Not live: ${named} and 2 more changed since this job started. ${KEPT}`);
  });

  test("regression: the same lines conflict", async () => {
    const { home, clone, sandboxes } = setup();
    write(home, "extensions/e/index.ts", "line 1 main\nline 2\n");
    git(home, "commit", "-q", "-a", "-m", "main");
    const before = git(home, "rev-parse", "HEAD");
    write(home, "settings.json", '{"local":true}\n'); // the settings tools write it at any time
    write(clone, "extensions/e/index.ts", "line 1 job\nline 2\n");
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe(`Not live: extensions/e/index.ts changed since this job started. ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(home, ".git", "MERGE_HEAD"))).toBe(false);
    expect(read(home, "extensions/e/index.ts")).toBe("line 1 main\nline 2\n");
    expect(read(home, "settings.json")).toBe('{"local":true}\n');
    expect(git(home, "status", "--porcelain")).toBe("M settings.json");
    expect(existsSync(clone)).toBe(true);
    expect(existsSync(join(home, ".jobs", "1.merged"))).toBe(false);
    expect(calls).toMatchObject({ changes: [], reconciles: 0 });
    expect(git(home, "for-each-ref", "refs/japa")).toBe("");
  });

  test("a load failure reverts", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(home, "settings.json", '{"local":true}\n');
    write(clone, "extensions/e/index.ts", "broken\n");
    const { publish, calls } = publisher(home, sandboxes.spec, {
      reconcile: async () => {
        calls.reconciles++;
        return { errors: [{ name: "e", error: "bad" }] };
      },
    });
    const line = `Not live: extensions/e failed to load: bad. Reverted. ${KEPT}`;
    expect(await publish(job)).toBe(line);
    expect(git(home, "diff", "--stat", base, "HEAD")).toBe("");
    expect(git(home, "status", "--porcelain")).toBe("M settings.json");
    expect(read(home, "settings.json")).toBe('{"local":true}\n');
    expect(read(home, "extensions/e/index.ts")).toBe(INDEX);
    expect(git(home, "rev-list", "--merges", "--count", "HEAD")).toBe("1"); // merged, then reverted
    expect(git(home, "log", "-1", "--format=%s")).toBe('Revert "Job 1: t"');
    expect(calls).toMatchObject({ changes: [], reconciles: 2, good: 0 });
    expect(existsSync(clone)).toBe(true);
    // Resumed in publish after a restart, it says the same and changes nothing: a merge again would be a no-op.
    const head = git(home, "rev-parse", "HEAD");
    expect(await publish(job)).toBe(line);
    expect(git(home, "rev-parse", "HEAD")).toBe(head);
    expect(calls).toMatchObject({ changes: [], reconciles: 2 });
  });

  test("a merged extension that already failed to load, at a boot after a restart, is reverted: not falsely live", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "broken\n");
    // Stopped once merged, before reconciling; the boot after loads the merged extension, which fails. A reconcile
    // then reports nothing new: the extension hasn't changed since.
    let booted = false;
    const { publish, calls } = publisher(home, sandboxes.spec, {
      reconcile: async () => {
        if (!booted) {
          booted = true;
          throw new Error("stopped");
        }
        calls.reconciles++;
        return { errors: [] };
      },
      errors: () => [
        { name: "workspace", error: "unrelated" },
        { name: "e", error: "bad" },
      ],
    });
    await expect(publish(job)).rejects.toThrow("stopped");
    expect(read(home, "extensions/e/index.ts")).toBe("broken\n");
    expect(await publish(job)).toBe(`Not live: extensions/e failed to load: bad. Reverted. ${KEPT}`);
    expect(git(home, "diff", "--stat", base, "HEAD")).toBe("");
    expect(calls).toMatchObject({ changes: [], good: 0 });
  });

  test("an error both reported by the reconcile and already known is shown once", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "broken\n");
    const { publish } = publisher(home, sandboxes.spec, {
      reconcile: async () => ({ errors: [{ name: "e", error: "bad" }] }),
      errors: () => [{ name: "e", error: "bad" }],
    });
    expect(await publish(job)).toBe(`Not live: extensions/e failed to load: bad. Reverted. ${KEPT}`);
  });

  test("live even when the fetched ref can't be deleted: that's logged, and boot prunes it", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    const lock = join(home, ".git", "refs", "japa", "jobs", "1.lock");
    const { publish, calls } = publisher(home, sandboxes.spec, {
      reconcile: async () => {
        calls.reconciles++;
        writeFileSync(lock, ""); // a git that stopped mid-update: the ref can't be deleted
        return { errors: [] };
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^Couldn't delete refs\/japa\/jobs\/1: /));
    expect(git(home, "for-each-ref", "--format=%(refname)", "refs/japa")).toBe("refs/japa/jobs/1");
  });

  test("load errors are shown on one line, without a doubled period, and cut short", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "broken\n");
    write(clone, "skills/s/SKILL.md", "not a skill\n");
    const long = `bad.\n    at ${"x".repeat(600)}.`;
    const { publish } = publisher(home, sandboxes.spec, {
      reconcile: async () => ({
        errors: [
          { name: "e", error: long },
          { name: "skill:s", error: "No frontmatter.\n" },
        ],
      }),
    });
    const cut = `bad. at ${"x".repeat(600)}`.slice(0, 500);
    expect(await publish(job)).toBe(
      `Not live: extensions/e failed to load: ${cut}\u2026; skills/s failed to load: No frontmatter. Reverted. ${KEPT}`,
    );
  });

  test("a revert made just before a restart is reported, not loaded again", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "broken\n");
    // Stopped once merged; then, as if the load had failed, the merge is reverted, but the marker isn't updated.
    let stopped = false;
    const { publish, calls } = publisher(home, sandboxes.spec, {
      logChange: async (change) => {
        if (!stopped) {
          stopped = true;
          throw new Error("stopped");
        }
        calls.changes.push(change);
        return "1";
      },
    });
    await expect(publish(job)).rejects.toThrow("stopped");
    git(home, "revert", "--no-edit", "-m", "1", "HEAD");
    const reverted = git(home, "rev-parse", "HEAD");
    const reconciles = calls.reconciles;
    const line = `Not live: extensions/e failed to load. Reverted. ${KEPT}`;
    expect(await publish(job)).toBe(line);
    expect(git(home, "rev-parse", "HEAD")).toBe(reverted);
    expect(calls).toMatchObject({ changes: [], reconciles });
    expect(existsSync(clone)).toBe(true);
    expect(JSON.parse(read(home, ".jobs/1.merged"))).toMatchObject({ reverted: line });
    expect(await publish(job)).toBe(line);
  });

  test("a skill that doesn't load reverts, with its error", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(clone, "skills/s/SKILL.md", "not a skill\n");
    const { publish } = publisher(home, sandboxes.spec, {
      reconcile: async () => ({ errors: [{ name: "skill:s", error: "no frontmatter" }] }),
      loaded: () => false,
    });
    expect(await publish(job)).toBe(`Not live: skills/s failed to load: no frontmatter. Reverted. ${KEPT}`);
    expect(git(home, "diff", "--stat", base, "HEAD")).toBe("");
    // Job 2, started after: its skills aren't loaded, without an error.
    const clone2 = ensureClone(home, packageRoot, "2");
    write(clone2, "skills/t/SKILL.md", "---\nname: t\ndescription: T\n---\n");
    write(clone2, "skills/u/SKILL.md", "---\nname: u\ndescription: U\n---\n");
    const quiet = publisher(home, sandboxes.spec, { loaded: () => false });
    expect(await quiet.publish({ id: "2", title: "t", seq: 1 })).toBe(
      "Not live: skills/t failed to load: did not load; skills/u failed to load: did not load. Reverted. " +
        "Kept at ~/.japa/.jobs/2.",
    );
    expect(git(home, "diff", "--stat", base, "HEAD")).toBe("");
    expect(existsSync(clone)).toBe(true);
  });

  test("a skill named otherwise than its folder goes live: it loads from that folder", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "skills/hello/SKILL.md", "---\nname: greeting\ndescription: Greets\n---\n");
    const { publish } = publisher(home, sandboxes.spec, {
      loaded: (_kind, name) => skillAt(loadSkills([join(home, "skills")]).skills, join(home, "skills", name)) !== undefined,
    });
    expect(await publish(job)).toBe("Live: skills/hello (change 1).");
    expect(read(home, "skills/hello/SKILL.md")).toContain("name: greeting");
    expect(existsSync(clone)).toBe(false);
  });

  test("merges while settings.json has local changes", async () => {
    const { home, clone, sandboxes } = setup();
    write(home, "settings.json", '{"local":true}\n');
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    expect(read(home, "settings.json")).toBe('{"local":true}\n');
    expect(read(home, "extensions/e/index.ts")).toBe("changed\n");
    expect(git(home, "status", "--porcelain")).toBe("M settings.json");
  });

  test("a deleted skill goes live without a check", async () => {
    const { home, clone, sandboxes } = setup({ "skills/s/SKILL.md": "---\nname: s\ndescription: S\n---\n" });
    rmSync(join(clone, "skills", "s"), { recursive: true });
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e, skills/s (change 1).");
    expect(calls.check).toEqual(["1:extensions/e"]);
    expect(existsSync(join(home, "skills", "s"))).toBe(false);
  });

  test("publish is idempotent after a merge", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    // The daemon stops after the merge, before the change is logged; the job resumes in publish.
    let stopped = false;
    const { publish, calls } = publisher(home, sandboxes.spec, {
      logChange: async (change) => {
        if (!stopped) {
          stopped = true;
          throw new Error("stopped");
        }
        calls.changes.push(change);
        return "7";
      },
    });
    await expect(publish(job)).rejects.toThrow("stopped");
    expect(existsSync(join(home, ".jobs", "1.merged"))).toBe(true);
    const merge = git(home, "rev-parse", "HEAD");
    expect(await publish(job)).toBe("Live: extensions/e (change 7).");
    expect(git(home, "rev-parse", "HEAD")).toBe(merge);
    expect(git(home, "rev-list", "--merges", "--count", "HEAD")).toBe("1");
    expect(calls.check).toEqual(["1:extensions/e"]); // checked once, before the merge
    expect(calls.changes).toEqual([{ title: "Job 1: changed extensions/e", howToUse: "", undo: { commits: [merge] } }]);
    expect(existsSync(clone)).toBe(false);
    expect(existsSync(join(home, ".jobs", "1.merged"))).toBe(false);
  });

  test("a merge made just before a restart, without its marker yet, isn't made again", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    let stopped = false;
    const { publish, calls } = publisher(home, sandboxes.spec, {
      reconcile: async () => {
        if (!stopped) {
          stopped = true;
          throw new Error("stopped");
        }
        calls.reconciles++;
        return { errors: [] };
      },
    });
    await expect(publish(job)).rejects.toThrow("stopped");
    const merge = git(home, "rev-parse", "HEAD");
    rmSync(join(home, ".jobs", "1.merged"));
    // And something else committed since (boot's adoption of edits made outside japa, say).
    write(home, "extensions/f/index.ts", "f\n");
    git(home, "add", "-A");
    git(home, "commit", "-q", "-m", "Edits made outside japa");
    const later = git(home, "rev-parse", "HEAD");
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    expect(git(home, "rev-parse", "HEAD")).toBe(later);
    expect(git(home, "rev-list", "--merges", "--count", "HEAD")).toBe("1");
    expect(calls.changes).toEqual([{ title: "Job 1: changed extensions/e", howToUse: "", undo: { commits: [merge] } }]);
  });

  test("thousands of new files are counted, not listed", { timeout: 60_000 }, async () => {
    // More than the last 1 MB of output the sandbox keeps, were they all printed: 4,500 paths of 255 characters.
    const names = Array.from({ length: 4500 }, (_, i) => `.venv/${"a".repeat(240)}/f${String(i).padStart(4, "0")}.py`);
    const { home, clone, sandboxes } = setup();
    mkdirSync(join(clone, dirname(names[0]!)), { recursive: true });
    for (const name of names) writeFileSync(join(clone, name), "");
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    // Three fit in 1,000 characters.
    const named = names.slice(0, 3).join(", ");
    expect(await publish(job)).toBe(`Live: extensions/e (change 1). Dropped: ${named} and 4497 more.`);
  });

  test("a list of dropped paths is cut at 1,000 characters", async () => {
    // 50 paths of 300 characters: three fit.
    const names = Array.from({ length: 50 }, (_, i) => `${"x".repeat(250)}/${String(i).padStart(2, "0")}${"y".repeat(47)}`);
    expect(names[0]).toHaveLength(300);
    const { home, clone, sandboxes } = setup();
    for (const name of names) write(clone, name, "n\n");
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    const named = names.slice(0, 3).join(", ");
    expect(await publish(job)).toBe(`Live: extensions/e (change 1). Dropped: ${named} and 47 more.`);
  });

  test("dropped paths: 50 at most are named, and none empty, multi-line or over 300 characters", async () => {
    const names = Array.from({ length: 53 }, (_, i) => `note${String(i).padStart(2, "0")}.md`);
    const { home, clone, sandboxes } = setup();
    for (const name of names) write(clone, name, "n\n");
    write(clone, "note\nx.md", "n\n");
    write(clone, `zz/${"a".repeat(250)}/${"b".repeat(60)}`, "n\n");
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    const shown = names.slice(0, 50).join(", ");
    expect(await publish(job)).toBe(`Live: extensions/e (change 1). Dropped: ${shown} and 5 more.`);
    // None it can name.
    const clone2 = ensureClone(home, packageRoot, "2");
    write(clone2, "a\nb.md", "n\n");
    write(clone2, "extensions/e/index.ts", "changed again\n");
    expect(await publish({ id: "2", title: "t", seq: 1 })).toBe("Live: extensions/e (change 2). Dropped: 1 path.");
  });

  test("a job whose clone was deleted, but not its marker, is still reported", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    // Stopped after the change was logged; then, deleting the clone, after the clone and its base.
    let stopped = false;
    const { publish, calls } = publisher(home, sandboxes.spec, {
      scheduleGood: () => {
        if (!stopped) {
          stopped = true;
          throw new Error("stopped");
        }
      },
    });
    await expect(publish(job)).rejects.toThrow("stopped");
    rmSync(clone, { recursive: true });
    rmSync(`${clone}.base`);
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    expect(calls.changes).toHaveLength(1);
    expect(existsSync(join(home, ".jobs", "1.merged"))).toBe(false);
    expect(await publish(job)).toBeUndefined();
  });

  test("an empty or garbled marker counts as none", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    const marker = join(home, ".jobs", "1.merged");
    for (const garbled of ["", '{"merge":"x"}']) {
      writeFileSync(marker, garbled);
      // Stopped once merged, before the change was logged.
      const stopper = publisher(home, sandboxes.spec, {
        logChange: async () => {
          throw new Error("stopped");
        },
      });
      await expect(stopper.publish(job)).rejects.toThrow("stopped");
    }
    const merge = git(home, "rev-parse", "HEAD");
    // Garbled after the merge: the merge is found in the history.
    writeFileSync(marker, '{"merge":');
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    expect(git(home, "rev-list", "--merges", "--count", "HEAD")).toBe("1");
    expect(calls.changes).toEqual([{ title: "Job 1: changed extensions/e", howToUse: "", undo: { commits: [merge] } }]);
  });

  test("a change logged before a restart isn't logged again", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "README.md", "r\n");
    write(clone, "extensions/e/index.ts", "changed\n");
    let stopped = false;
    const { publish, calls } = publisher(home, sandboxes.spec, {
      scheduleGood: () => {
        calls.good++;
        if (!stopped) {
          stopped = true;
          throw new Error("stopped");
        }
      },
    });
    await expect(publish(job)).rejects.toThrow("stopped");
    expect(await publish(job)).toBe("Live: extensions/e (change 1). Dropped: README.md.");
    expect(calls.changes).toHaveLength(1);
    expect(calls.good).toBe(2);
    expect(git(home, "rev-list", "--merges", "--count", "HEAD")).toBe("1");
  });

  test("a marker the job planted in its clone is ignored", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    // Where the old design kept it, and where `~/.japa/.jobs/1.merged` is in the job's sandbox.
    write(clone, ".git/japa-merged", `${base}\n`);
    write(clone, ".jobs/1.merged", JSON.stringify({ merge: base, dropped: [], change: "9" }));
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    expect(git(home, "rev-list", "--merges", "--count", "HEAD")).toBe("1");
    expect(read(home, "extensions/e/index.ts")).toBe("changed\n");
    expect(calls.changes).toHaveLength(1);
  });

  test("a title with quotes and $(…) is committed verbatim", async () => {
    const { outside, home, clone, sandboxes } = setup();
    const title = `it's "quoted" $(touch "${outside}/pwned") \`touch "${outside}/pwned2"\` $HOME; echo hi`;
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish({ id: "1", title, seq: 1 })).toBe("Live: extensions/e (change 1).");
    expect(git(home, "log", "-1", "--format=%B", "HEAD")).toBe(`Job 1: ${title}`);
    expect(git(home, "log", "-1", "--format=%B", "HEAD^2")).toBe(`Job 1: ${title}`);
    expect(calls.changes[0]?.title).toBe("Job 1: changed extensions/e");
    expect(existsSync(join(outside, "pwned"))).toBe(false);
    expect(existsSync(join(outside, "pwned2"))).toBe(false);
  });

  // The clone's `.git` is the job's: its hooks, and its config's `core.hooksPath` and `core.fsmonitor`, would run
  // whatever git the daemon ran there. Each script below appends its name and the PID namespace it runs in to a log
  // in the scratch dir (the same path inside the sandbox and out). The sandbox has its own PID namespace
  // (`--unshare-pid`), so an entry with the test's own namespace would be a script the daemon ran outside it.
  test("the job's hooks and git config never run outside its sandbox", async () => {
    const { outside, home, clone, sandboxes } = setup();
    const log = join(outside, "spy.log");
    const spy = (name: string, status: number) =>
      `#!/bin/sh\necho "${name} $(readlink /proc/self/ns/pid)" >> "${log}"\nexit ${status}\n`;
    const hooks = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-merge-commit", "post-merge",
      "post-checkout", "post-rewrite", "reference-transaction", "post-index-change", "pre-auto-gc"];
    const hooksPath = join(outside, "hooks");
    mkdirSync(hooksPath);
    for (const hook of hooks) {
      writeFileSync(join(clone, ".git", "hooks", hook), spy(hook, 0), { mode: 0o755 });
      writeFileSync(join(hooksPath, hook), spy(`hooksPath ${hook}`, 0), { mode: 0o755 });
    }
    // "Can't tell" (non-zero): git then looks at every file itself.
    writeFileSync(join(outside, "fsmonitor"), spy("fsmonitor", 1), { mode: 0o755 });
    git(clone, "config", "core.hooksPath", hooksPath);
    git(clone, "config", "core.fsmonitor", join(outside, "fsmonitor"));
    write(clone, "extensions/e/index.ts", "changed\n");
    const { publish } = publisher(home, sandboxes.spec);
    expect(await publish(job)).toBe("Live: extensions/e (change 1).");
    const host = execFileSync("readlink", ["/proc/self/ns/pid"], { encoding: "utf8" }).trim();
    const entries = readFileSync(log, "utf8").trim().split("\n");
    // The fsmonitor ran (the log works), in the sandbox; the hooks didn't run at all.
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatch(/^fsmonitor pid:\[\d+\]$/);
      expect(entry).not.toBe(`fsmonitor ${host}`);
    }
  });

  test("sandboxCheck runs japa check on the job's clone, in its sandbox", { timeout: 60_000 }, async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "skills/ok/SKILL.md", "---\nname: ok\ndescription: Fine\n---\n");
    write(clone, "skills/bad/SKILL.md", "---\nname: bad\n---\n");
    // Only in the real tree: the check sees the clone's.
    write(home, "skills/real/SKILL.md", "---\nname: real\ndescription: Real\n---\n");
    const check = sandboxCheck(sandboxes.spec, home, packageRoot);
    expect(await check("1", "skill", "ok")).toEqual([]);
    expect(await check("1", "skill", "bad")).toEqual([expect.stringContaining("description is required")]);
    expect(await check("1", "skill", "real")).toEqual([expect.stringContaining("does not exist")]);
    await expect(check("1", "skill", "ok", AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });

  test("a stopped job merges nothing: its clone is kept, and the line says so", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(clone, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\n");
    const { publish, calls } = publisher(home, sandboxes.spec);
    expect(await publish({ ...job, stopped: true })).toBe(`Not live: the job was stopped. ${KEPT}`);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(read(clone, "skills/s/SKILL.md")).toContain("name: s");
    expect(calls).toMatchObject({ check: [], reconciles: 0, changes: [] });
    // Job 2 never made a tool call, so it has no clone.
    expect(await publish({ id: "2", title: "t", seq: 1, stopped: true })).toBeUndefined();
  });

  test("a stopped job whose merge was made before a restart goes on: it is live", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "extensions/e/index.ts", "changed\n");
    let stopped = false;
    const { publish } = publisher(home, sandboxes.spec, {
      logChange: async () => {
        if (stopped) return "1";
        stopped = true;
        throw new Error("stopped");
      },
    });
    await expect(publish(job)).rejects.toThrow("stopped");
    expect(await publish({ ...job, stopped: true })).toBe("Live: extensions/e (change 1).");
    expect(existsSync(clone)).toBe(false);
  });

  // The job's earlier commits are in the real history, merged then reverted: they stay reverted.
  test("a publish for a later report starts afresh, merging what changed since a reverted one", async () => {
    const { home, clone, sandboxes } = setup();
    write(clone, "skills/s/SKILL.md", "not a skill\n");
    let errors = [{ name: "skill:s", error: "no frontmatter" }];
    const { publish } = publisher(home, sandboxes.spec, { reconcile: async () => ({ errors }) });
    expect(await publish(job)).toBe(`Not live: skills/s failed to load: no frontmatter. Reverted. ${KEPT}`);
    expect(await publish(job)).toBe(`Not live: skills/s failed to load: no frontmatter. Reverted. ${KEPT}`);
    // A follow-up that changes nothing hands over the reverted merge's commit again: it's found reverted.
    expect(await publish({ ...job, seq: 2 })).toBe(`Not live: skills/s failed to load. Reverted. ${KEPT}`);
    // A follow-up adds skill t, and completes the job again.
    write(clone, "skills/t/SKILL.md", "---\nname: t\ndescription: T\n---\n");
    errors = [];
    expect(await publish({ ...job, seq: 3 })).toBe("Live: skills/t (change 1).");
    expect(read(home, "skills/t/SKILL.md")).toContain("name: t");
    expect(existsSync(join(home, "skills", "s"))).toBe(false);
    expect(existsSync(clone)).toBe(false);
  });

  test("an abort mid-check rejects at once and merges nothing; publishing again goes live", async () => {
    const { outside, home, clone, sandboxes, base } = setup();
    write(clone, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\n");
    const checking = join(outside, "checking");
    const controller = new AbortController();
    const { publish } = publisher(home, sandboxes.spec, {
      check: async (jobId, _kind, _name, signal) => {
        const command = ["bash", "-c", `touch "${checking}"; sleep 30`];
        await runSandboxed(sandboxes.spec(jobId), command, { timeoutMs: 60_000, signal });
        return [];
      },
    });
    const publishing = publish(job, controller.signal);
    await waitFor(() => existsSync(checking));
    const started = performance.now();
    controller.abort();
    await expect(publishing).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(git(home, "for-each-ref", "refs/japa")).toBe("");
    expect(existsSync(join(home, ".jobs", "1.merged"))).toBe(false);
    expect(await publisher(home, sandboxes.spec).publish(job)).toBe("Live: skills/s (change 1).");
  });

  test("an abort mid-commit rejects at once; publishing again goes live, past the index.lock git left", async () => {
    const { outside, home, clone, sandboxes, base } = setup();
    write(clone, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\n");
    const committing = join(outside, "committing");
    // The job's clean filter, which `git add` runs with the index locked: the first time, it waits.
    git(clone, "config", "filter.slow.clean", `sh -c '[ -e "${committing}" ] || { touch "${committing}"; sleep 30; }; cat'`);
    writeFileSync(join(clone, ".git", "info", "attributes"), "*.md filter=slow\n");
    const controller = new AbortController();
    const publishing = publisher(home, sandboxes.spec).publish(job, controller.signal);
    await waitFor(() => existsSync(committing));
    const started = performance.now();
    controller.abort();
    await expect(publishing).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(clone, ".git", "index.lock"))).toBe(true); // git was killed holding it
    expect(await publisher(home, sandboxes.spec).publish(job)).toBe("Live: skills/s (change 1).");
  });

  test("an abort while waiting for the lock merges nothing", async () => {
    const { home, clone, sandboxes, base } = setup();
    write(clone, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\n");
    const lock = createWorkspaceLock();
    let release = () => {};
    const held = lock(() => new Promise<void>((resolve) => (release = resolve)));
    let checked = false;
    const controller = new AbortController();
    const { publish } = publisher(home, sandboxes.spec, {
      lock,
      check: async () => {
        checked = true;
        return [];
      },
    });
    const publishing = publish(job, controller.signal);
    await waitFor(() => checked);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    release();
    await held;
    await expect(publishing).rejects.toMatchObject({ name: "AbortError" });
    expect(git(home, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(home, ".jobs", "1.merged"))).toBe(false);
  });
});

test("a publish that throws ends in a Not live line, on one line and capped", async () => {
  const home = join(homedir(), ".japa");
  const publish = reportingFailures(home, async () => {
    throw new Error(`boom\n  at ${"x".repeat(600)}.`);
  });
  const line = await publish(job);
  expect(line).toBe(`Not live: publishing failed: boom at ${"x".repeat(492)}…. ${KEPT}`);
  const quiet = reportingFailures(home, async () => "Live: skills/s (change 1).");
  expect(await quiet(job)).toBe("Live: skills/s (change 1).");
});

test("a publish aborted (the daemon closing) still rejects: it resumes after the restart", async () => {
  const home = join(homedir(), ".japa");
  const publish = reportingFailures(home, async (_job, signal) => {
    signal!.throwIfAborted();
    return "Live: skills/s (change 1).";
  });
  await expect(publish(job, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

test("the lock serialises, and a rejected call doesn't stop the next", async () => {
  const lock = createWorkspaceLock();
  const order: string[] = [];
  let release!: () => void;
  const first = lock(async () => {
    order.push("first starts");
    await new Promise<void>((resolve) => (release = resolve));
    order.push("first ends");
    throw new Error("boom");
  });
  const second = lock(async () => {
    order.push("second");
    return 2;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(order).toEqual(["first starts"]);
  release();
  await expect(first).rejects.toThrow("boom");
  await expect(second).resolves.toBe(2);
  expect(order).toEqual(["first starts", "first ends", "second"]);
});
