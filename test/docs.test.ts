import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function headingIds(markdown: string): Set<string> {
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  for (const heading of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = heading[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, "")
      .replace(/ /g, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    ids.add(count ? `${base}-${count}` : base);
  }
  return ids;
}

test("documentation links resolve to local files and headings", async () => {
  const files = [
    "README.md",
    "ARCHITECTURE.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    ...(await markdownFiles("docs")),
  ];
  let checked = 0;
  for (const filename of files) {
    const text = await readFile(filename, "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1]!;
      if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const [path, fragment] = target.split("#");
      const destination = path
        ? resolve(dirname(filename), decodeURIComponent(path))
        : resolve(filename);
      const info = await stat(destination).catch(() => undefined);
      assert(info, `${filename}: missing link target ${target}`);
      if (fragment && destination.endsWith(".md")) {
        assert(
          headingIds(await readFile(destination, "utf8")).has(
            decodeURIComponent(fragment),
          ),
          `${filename}: missing heading in ${target}`,
        );
      }
      checked++;
    }
  }
  assert(checked > 0, "the documentation must contain navigable local links");
});
