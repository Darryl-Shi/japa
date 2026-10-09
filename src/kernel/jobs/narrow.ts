// What a finished job hands over to go live, made in its own sandbox: `node narrow.ts <base> <message> <out> [quiet...]`,
// run in its clone (the japa home there). The clone and its `.git` are the job's, so the daemon runs no git in it
// itself (see publish.ts). Prints `{ dropped, droppedCount, bundle }` (see `narrow`) as its last line, or fails with
// git's error.
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_LINK, SDK_PACKAGE_JSON } from "../sdk-link.ts";
import { git, gitError, gitPaths } from "../workspace.ts";

/** The file `narrow` bundles the job's commits into, in its out dir. */
export const BUNDLE = "publish.bundle";

/** Whether `path`, relative to the japa home, is under extensions/ or skills/, where the components are. */
export const inComponents = (path: string) => /^(extensions|skills)\/./.test(path);

/** How many paths an outcome line names, at most, and how long each may be. */
export const MAX_NAMED = 50;
const MAX_PATH = 300;

/** Whether `path` can be named on an outcome line: not empty, on one line, and 300 characters at most. */
export const nameable = (path: string) => path !== "" && path.length <= MAX_PATH && !/[\0\r\n]/.test(path);

/** Files that tell git how to check out, fetch or filter others: never published, in a component either. */
const GIT_FILES = new Set([".gitattributes", ".lfsconfig", ".gitmodules"]);

/**
 * Whether `path`, relative to the japa home, can go live: it's in a component, has no empty, `.`, `..` or `.git`
 * folder, and isn't a git file (`.gitattributes`, `.lfsconfig`, `.gitmodules`). Case doesn't matter.
 */
export function publishable(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const odd = parts.some((part) => part === "" || part === "." || part === ".." || part === ".git");
  return inComponents(path) && !odd && !GIT_FILES.has(parts.at(-1)!);
}

/**
 * In the clone at `dir`: stages everything, then puts each staged path that can't go live (see `publishable`) back in
 * the index as it is at `base` (the working tree keeps the job's files: nothing there is deleted, a folder mounted from
 * outside included). Commits what's left as `message` when that differs from HEAD, and bundles `base..HEAD` into
 * `<out>/publish.bundle`. Returns how many paths it put back (`droppedCount`), but those under `quiet` paths (the
 * folders the sandbox mounts in the home) and what `linkSdk` made; the first 50 of them that are `nameable`
 * (`dropped`: a job can leave thousands, a virtualenv say, more than the sandbox's output keeps); and whether it made a
 * bundle: not when nothing is left changed since `base`.
 */
export function narrow(
  dir: string,
  base: string,
  message: string,
  out: string,
  quiet: string[] = [],
): { dropped: string[]; droppedCount: number; bundle: boolean } {
  rmSync(join(out, BUNDLE), { force: true });
  git(dir, "add", "-A");
  const staged = (...filter: string[]) =>
    gitPaths(dir, "diff", "--cached", "--name-only", "--no-renames", "-z", ...filter, base).filter(
      (path) => !publishable(path),
    );
  const unpublished = staged();
  const added = new Set(staged("--diff-filter=A"));
  const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
  const linked = (path: string) =>
    path === SDK_LINK || (path === "package.json" && added.has(path) && sdkPackage(dir));
  const reported = unpublished.filter((path) => !linked(path) && !quiet.some((folder) => under(path, folder)));
  const dropped = reported.filter(nameable).slice(0, MAX_NAMED);
  const droppedCount = reported.length;
  if (unpublished.length > 0) {
    // From a file: there may be more than a command line holds. Literal: a name like `*` is no pattern.
    const list = join(out, "publish.dropped");
    writeFileSync(list, unpublished.join("\0"));
    git(dir, "--literal-pathspecs", "reset", "-q", base, `--pathspec-from-file=${list}`, "--pathspec-file-nul");
    rmSync(list);
  }
  const tree = git(dir, "write-tree");
  if (tree === git(dir, "rev-parse", `${base}^{tree}`)) return { dropped, droppedCount, bundle: false };
  if (tree !== git(dir, "rev-parse", "HEAD^{tree}")) {
    git(dir, "commit", "-q", "--no-verify", "--cleanup=whitespace", "-m", message);
  }
  git(dir, "bundle", "create", "-q", join(out, BUNDLE), `${base}..HEAD`);
  return { dropped, droppedCount, bundle: true };
}

/** Whether `<dir>/package.json` is the one `linkSdk` writes. */
function sdkPackage(dir: string): boolean {
  try {
    return readFileSync(join(dir, "package.json"), "utf8") === SDK_PACKAGE_JSON;
  } catch {
    return false;
  }
}

function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [base, message, out, ...quiet] = process.argv.slice(2);
  try {
    console.log(JSON.stringify(narrow(process.cwd(), base!, message!, out!, quiet)));
  } catch (error) {
    console.error(gitError(error));
    process.exitCode = 1;
  }
}
