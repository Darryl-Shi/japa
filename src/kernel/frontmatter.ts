export type FrontmatterValue = string | string[] | Record<string, string>;

/** Parses a `---`-delimited header of `key: value` lines (scalars, `[a, b]` lists, `{ k: v }` maps) and the body after it. */
export function parseFrontmatter(text: string): { data: Record<string, FrontmatterValue>; body: string } {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1) throw new Error("missing frontmatter");

  const data: Record<string, FrontmatterValue> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i].replace(/\s#.*$/, "").trim();
    if (!line) continue;
    const pair = splitPair(line);
    if (!pair) throw new Error(`line ${i + 1}: expected "key: value"`);
    data[pair[0]] = parseValue(pair[1], i + 1);
  }
  return { data, body: lines.slice(end + 1).join("\n").trim() };
}

function splitPair(text: string): [string, string] | undefined {
  const match = /^([\w-]+):\s*(.*)$/.exec(text.trim());
  return match ? [match[1], match[2].trim()] : undefined;
}

function parseValue(value: string, line: number): FrontmatterValue {
  if (value.startsWith("[") && value.endsWith("]")) return items(value).map((s) => s.trim());
  if (value.startsWith("{") && value.endsWith("}")) {
    const map: Record<string, string> = {};
    for (const item of items(value)) {
      const pair = splitPair(item);
      if (!pair) throw new Error(`line ${line}: expected "{ key: value, ... }"`);
      map[pair[0]] = pair[1];
    }
    return map;
  }
  return value;
}

function items(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  return inner ? inner.split(",") : [];
}
