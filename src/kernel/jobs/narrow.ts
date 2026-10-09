// What a finished job hands over to go live, made in its own sandbox: `node narrow.ts <base> <message> <out>`, run in
// its clone (the japa home there). The clone and its `.git` are the job's, so the daemon runs no git in it itself (see
// publish.ts). Prints `{ dropped, bundle }` (see `narrow`) as its last line, or fails with git's error.
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitError, gitPaths } from "../workspace.ts";

/** The file `narrow` bundles the job's commits into, in its out dir. */
export const BUNDLE = "publish.bundle";

/** Whether `path`, relative to the japa home, is in a component (the only paths that go live): under extensions/ or skills/. */
export const inComponents = (path: string) => /^(extensions|skills)\/./.test(path);

/**
 * In the clone at `dir`: stages everything, then puts each staged path outside the components back in the index as it
 * is at `base` (the working tree keeps the job's files: nothing there is deleted, a folder mounted from outside
 * included). Commits what's left as `message` when that differs from HEAD, and bundles `base..HEAD` into
 * `<out>/publish.bundle`. Returns the paths put back that `base` has (`dropped`: new ones, like the `package.json`
 * `linkSdk` makes, go silently), and whether it made a bundle: not when nothing is left changed since `base`.
 */
export function narrow(dir: string, base: string, message: string, out: string): { dropped: string[]; bundle: boolean } {
  rmSync(join(out, BUNDLE), { force: true });
  git(dir, "add", "-A");
  const staged = (...filter: string[]) =>
    gitPaths(dir, "diff", "--cached", "--name-only", "--no-renames", "-z", ...filter, base).filter(
      (path) => !inComponents(path),
    );
  const outside = staged();
  const added = new Set(staged("--diff-filter=A"));
  if (outside.length > 0) {
    // From a file: there may be more than a command line holds. Literal: a name like `*` is no pattern.
    const list = join(out, "publish.dropped");
    writeFileSync(list, outside.join("\0"));
    git(dir, "--literal-pathspecs", "reset", "-q", base, `--pathspec-from-file=${list}`, "--pathspec-file-nul");
    rmSync(list);
  }
  const dropped = outside.filter((path) => !added.has(path));
  const tree = git(dir, "write-tree");
  if (tree === git(dir, "rev-parse", `${base}^{tree}`)) return { dropped, bundle: false };
  if (tree !== git(dir, "rev-parse", "HEAD^{tree}")) {
    git(dir, "commit", "-q", "--no-verify", "--cleanup=whitespace", "-m", message);
  }
  git(dir, "bundle", "create", "-q", join(out, BUNDLE), `${base}..HEAD`);
  return { dropped, bundle: true };
}

function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [base, message, out] = process.argv.slice(2);
  try {
    console.log(JSON.stringify(narrow(process.cwd(), base!, message!, out!)));
  } catch (error) {
    console.error(gitError(error));
    process.exitCode = 1;
  }
}
