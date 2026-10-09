import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  dropOldNode,
  ensurePrivateNode,
  isPrivateNode,
  major,
  MIN_NODE_MAJOR,
  NODE_MARKER,
  nodeDist,
  restoreNode,
  verifySha256,
} from "../src/cli/node.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "japa-node-"));

/** Builds `node-v<version>-<dist>.tar.gz` in `dir`: a top-level dir holding `bin/node`, a script that prints `v<version>`. */
function buildNodeTarball(dir: string, version: string, dist: string): { tarball: string; name: string } {
  const top = `node-v${version}-${dist}`;
  const name = `${top}.tar.gz`;
  mkdirSync(join(dir, top, "bin"), { recursive: true });
  writeFileSync(join(dir, top, "bin", "node"), `#!/bin/sh\necho v${version}\n`, { mode: 0o755 });
  const tarball = join(dir, name);
  execFileSync("tar", ["-czf", tarball, "-C", dir, top]);
  return { tarball, name };
}

/** A local HTTP server answering fixed routes (`"/path"` -> status/body, else 404). */
async function serve(routes: Record<string, { status: number; body: Buffer | string }>) {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? ""];
    if (route === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(route.status).end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, close: () => server.close() };
}

test("major accepts v-prefixed and bare versions", () => {
  expect(major("v24.1.0")).toBe(24);
  expect(major("24.1.0")).toBe(24);
  expect(MIN_NODE_MAJOR).toBe(24);
});

test("nodeDist", () => {
  expect(nodeDist("linux", "x64")).toBe("linux-x64");
  expect(nodeDist("linux", "arm64")).toBe("linux-arm64");
  expect(() => nodeDist("darwin", "arm64")).toThrow("japa supports Linux on x64 or arm64");
  expect(() => nodeDist("win32", "x64")).toThrow("japa supports Linux on x64 or arm64");
  expect(() => nodeDist("linux", "ia32")).toThrow("japa supports Linux on x64 or arm64");
});

test("verifySha256 rejects a mismatch and a missing entry", () => {
  const dir = tmp();
  const file = join(dir, "node-v9.9.9-linux-x64.tar.gz");
  writeFileSync(file, "fake tarball bytes");
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  const shasums = `${hash}  node-v9.9.9-linux-x64.tar.gz\n${"0".repeat(64)}  node-v9.9.9-linux-arm64.tar.gz\n`;

  expect(() => verifySha256(file, shasums, "node-v9.9.9-linux-x64.tar.gz")).not.toThrow();
  expect(() => verifySha256(file, shasums, "node-v9.9.9-linux-arm64.tar.gz")).toThrow(
    "checksum mismatch for node-v9.9.9-linux-arm64.tar.gz",
  );
  expect(() => verifySha256(file, shasums, "node-v9.9.9-linux-ppc64le.tar.gz")).toThrow(
    "node-v9.9.9-linux-ppc64le.tar.gz is not in SHASUMS256.txt",
  );
});

test("ensurePrivateNode installs from a mirror and keeps the old one aside", async () => {
  const src = tmp();
  const { tarball, name } = buildNodeTarball(src, "9.9.9", "linux-x64");
  const bytes = readFileSync(tarball);
  const hash = createHash("sha256").update(bytes).digest("hex");

  const nodeDir = join(tmp(), "node");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, NODE_MARKER), "");
  writeFileSync(join(nodeDir, "marker"), "old node");

  const { baseUrl, close } = await serve({
    [`/v9.9.9/${name}`]: { status: 200, body: bytes },
    "/v9.9.9/SHASUMS256.txt": { status: 200, body: `${hash}  ${name}\n` },
  });
  try {
    const node = await ensurePrivateNode("9.9.9", nodeDir, { baseUrl, platform: "linux", arch: "x64" });
    expect(node).toBe(join(nodeDir, "bin", "node"));
    expect(execFileSync(node, { encoding: "utf8" }).trim()).toBe("v9.9.9");
    expect(readFileSync(join(`${nodeDir}.old`, "marker"), "utf8")).toBe("old node");
    expect(isPrivateNode(nodeDir)).toBe(true); // marked as japa's, so a later update or uninstall may replace it
  } finally {
    close();
  }
});

test("ensurePrivateNode never replaces a node/ japa didn't install", async () => {
  const nodeDir = join(tmp(), "node");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, "keep.txt"), "mine");

  await expect(ensurePrivateNode("9.9.9", nodeDir, { baseUrl: "http://127.0.0.1:9", platform: "linux", arch: "x64" })).rejects.toThrow(
    `${nodeDir} exists and wasn't installed by japa`,
  );
  expect(readFileSync(join(nodeDir, "keep.txt"), "utf8")).toBe("mine");
  expect(existsSync(`${nodeDir}.old`)).toBe(false);
  expect(isPrivateNode(nodeDir)).toBe(false);
});

test("ensurePrivateNode with a bad checksum leaves nodeDir untouched", async () => {
  const src = tmp();
  const { tarball, name } = buildNodeTarball(src, "9.9.9", "linux-x64");
  const bytes = readFileSync(tarball);

  const nodeDir = join(tmp(), "node");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, NODE_MARKER), "");
  writeFileSync(join(nodeDir, "marker"), "old node");

  const { baseUrl, close } = await serve({
    [`/v9.9.9/${name}`]: { status: 200, body: bytes },
    "/v9.9.9/SHASUMS256.txt": { status: 200, body: `${"0".repeat(64)}  ${name}\n` },
  });
  try {
    await expect(ensurePrivateNode("9.9.9", nodeDir, { baseUrl, platform: "linux", arch: "x64" })).rejects.toThrow(
      `checksum mismatch for ${name}`,
    );
    expect(readFileSync(join(nodeDir, "marker"), "utf8")).toBe("old node");
    expect(existsSync(`${nodeDir}.old`)).toBe(false);
    expect(existsSync(`${nodeDir}.new`)).toBe(false);
  } finally {
    close();
  }
});

test("a failed download names the URL", async () => {
  const nodeDir = join(tmp(), "node");
  const { baseUrl, close } = await serve({});
  try {
    await expect(ensurePrivateNode("9.9.9", nodeDir, { baseUrl, platform: "linux", arch: "x64" })).rejects.toThrow(
      /could not download .*node-v9\.9\.9/,
    );
  } finally {
    close();
  }
});

test("restoreNode puts the old node back; dropOldNode discards it", () => {
  const nodeDir = join(tmp(), "node");
  mkdirSync(nodeDir);
  writeFileSync(join(nodeDir, "f"), "new");
  mkdirSync(`${nodeDir}.old`);
  writeFileSync(join(`${nodeDir}.old`, "f"), "old");

  restoreNode(nodeDir);
  expect(readFileSync(join(nodeDir, "f"), "utf8")).toBe("old");
  expect(existsSync(`${nodeDir}.old`)).toBe(false);

  mkdirSync(`${nodeDir}.old`);
  dropOldNode(nodeDir);
  expect(existsSync(`${nodeDir}.old`)).toBe(false);
});

test("restoreNode is a no-op when there is nothing to restore", () => {
  expect(() => restoreNode(join(tmp(), "node"))).not.toThrow();
});
