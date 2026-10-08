// Downloads and verifies a private Node.js runtime for a managed install (design doc §3.1 step 5, §5.1 step 4).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MIN_NODE_MAJOR = 24;

/** The major version number from `v24.1.0` or `24.1.0`. */
export function major(version: string): number {
  const bare = version.startsWith("v") ? version.slice(1) : version;
  return Number.parseInt(bare.split(".")[0] ?? "", 10);
}

/** nodejs.org's dist name for `platform`/`arch`, e.g. `linux-x64`. */
export function nodeDist(platform: NodeJS.Platform, arch: string): string {
  if ((platform !== "linux" && platform !== "darwin") || (arch !== "x64" && arch !== "arm64")) {
    throw new Error("japa supports Linux and macOS on x64 or arm64");
  }
  return `${platform}-${arch}`;
}

/** Throws if `file`'s SHA-256 doesn't match `name`'s entry in `shasums` (the contents of a SHASUMS256.txt). */
export function verifySha256(file: string, shasums: string, name: string): void {
  const entry = shasums
    .split("\n")
    .map((line) => /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line))
    .find((m) => m?.[2] === name);
  if (!entry) throw new Error(`${name} is not in SHASUMS256.txt`);
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual.toLowerCase() !== entry[1]!.toLowerCase()) throw new Error(`checksum mismatch for ${name}`);
}

async function fetchOrThrow(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`could not download ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`could not download ${url}: ${response.status} ${response.statusText}`);
  return response;
}

/**
 * Downloads and verifies `node-v<version>-<dist>.tar.gz` from `<baseUrl>/v<version>/` against its `SHASUMS256.txt`,
 * extracts it into `<nodeDir>.new` (stripping the tarball's top-level dir), moves the current `nodeDir` aside to
 * `<nodeDir>.old` (if one exists), and promotes `<nodeDir>.new` to `nodeDir`. Returns the new `node` binary's path.
 * On failure, `nodeDir` (and any existing `.old`) are left untouched.
 */
export async function ensurePrivateNode(
  version: string,
  nodeDir: string,
  opts: { baseUrl?: string; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<string> {
  const baseUrl = opts.baseUrl ?? "https://nodejs.org/dist";
  const dist = nodeDist(opts.platform ?? process.platform, opts.arch ?? process.arch);
  const name = `node-v${version}-${dist}.tar.gz`;
  const dir = `${baseUrl}/v${version}`;
  const tarball = `${nodeDir}.tar.gz`;
  const newDir = `${nodeDir}.new`;
  const oldDir = `${nodeDir}.old`;

  mkdirSync(dirname(nodeDir), { recursive: true });
  const tarResponse = await fetchOrThrow(`${dir}/${name}`);
  writeFileSync(tarball, Buffer.from(await tarResponse.arrayBuffer()));
  try {
    const shasums = await (await fetchOrThrow(`${dir}/SHASUMS256.txt`)).text();
    verifySha256(tarball, shasums, name);
    rmSync(newDir, { recursive: true, force: true });
    mkdirSync(newDir, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", newDir, "--strip-components=1"]);
  } finally {
    rmSync(tarball, { force: true });
  }

  rmSync(oldDir, { recursive: true, force: true });
  if (existsSync(nodeDir)) renameSync(nodeDir, oldDir);
  renameSync(newDir, nodeDir);
  return join(nodeDir, "bin", "node");
}

/** Puts `<nodeDir>.old` back as `nodeDir`, undoing `ensurePrivateNode`. A no-op if there is no `.old` to restore. */
export function restoreNode(nodeDir: string): void {
  const oldDir = `${nodeDir}.old`;
  if (!existsSync(oldDir)) return;
  rmSync(nodeDir, { recursive: true, force: true });
  renameSync(oldDir, nodeDir);
}

/** Removes `<nodeDir>.old` once an update that replaced it is confirmed good. */
export function dropOldNode(nodeDir: string): void {
  rmSync(`${nodeDir}.old`, { recursive: true, force: true });
}
