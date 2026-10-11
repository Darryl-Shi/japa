import { expect, test } from "vitest";
import {
  ACTIVE_PAGES,
  ARCHIVE_AFTER,
  DELETE_AFTER,
  findPage,
  PAGE_TOKENS,
  renderIndex,
  type Scratchpad,
  ScratchpadDoc,
  tidyPages,
  writePage,
} from "../src/kernel/memory/scratchpad.ts";

const DAY = 86_400_000;
const pad = (): Scratchpad => ScratchpadDoc.definition.initial();

test("the scratchpad doc and its caps", () => {
  expect(ScratchpadDoc.definition.kind).toBe("japa.scratchpad");
  expect(pad()).toEqual({ nextId: 1, pages: [] });
  expect([PAGE_TOKENS, ACTIVE_PAGES, ARCHIVE_AFTER, DELETE_AFTER]).toEqual([1500, 15, 14 * DAY, 90 * DAY]);
});

test("a page over 1,500 tokens is refused with the copy", () => {
  const p = pad();
  expect(writePage(p, "Big", "x".repeat(6000), 1)).toMatchObject({ page: { title: "Big" }, created: true }); // 1,500 fits
  expect(writePage(p, "Big", "x".repeat(8001), 2)).toEqual({
    error: "Page too long (2,001 tokens; max 1,500): condense it to the current state and write it again.",
  });
  expect(findPage(p, "big")!.text).toBe("x".repeat(6000));
});

test("writing a page creates it, then replaces it by case-insensitive title", () => {
  const p = pad();
  const first = writePage(p, "Home servers", "two boxes", 1);
  expect(first).toEqual({ page: { id: "1", title: "Home servers", text: "two boxes", updatedAt: 1 }, created: true });
  const second = writePage(p, "home SERVERS", "three boxes", 2);
  expect(second).toEqual({ page: { id: "1", title: "Home servers", text: "three boxes", updatedAt: 2 }, created: false });
  expect(p.pages).toHaveLength(1);
  expect(findPage(p, "HOME servers")?.id).toBe("1");
  expect(findPage(p, "Home")).toBeUndefined();
});

test("titles are trimmed when finding and writing", () => {
  const p = pad();
  expect(writePage(p, "  Home servers ", "two boxes", 1)).toMatchObject({ page: { title: "Home servers" }, created: true });
  expect(findPage(p, "Home servers ")?.id).toBe("1");
  expect(writePage(p, "Home servers ", "three boxes", 2)).toMatchObject({ page: { id: "1", text: "three boxes" }, created: false });
  expect(p.pages).toHaveLength(1);
});

test("the 16th active page archives the least recently updated", () => {
  const p = pad();
  for (let i = 1; i <= 15; i++) writePage(p, `P${i}`, "t", 100 + i);
  writePage(p, "P1", "touched", 200); // P2 is now the least recently updated
  expect(p.pages.every((page) => page.archivedAt === undefined)).toBe(true);
  writePage(p, "P16", "t", 300);
  expect(findPage(p, "P2")!.archivedAt).toBe(300);
  expect(p.pages.filter((page) => page.archivedAt === undefined)).toHaveLength(15);
  expect(findPage(p, "P16")!.archivedAt).toBeUndefined();
});

test("the new page is never the one archived, even at the same time", () => {
  const p = pad();
  for (let i = 1; i <= 16; i++) writePage(p, `P${i}`, "t", 5);
  expect(findPage(p, "P16")!.archivedAt).toBeUndefined();
  expect(p.pages.filter((page) => page.archivedAt !== undefined)).toHaveLength(1);
});

test("writing an archived page reactivates it", () => {
  const p = pad();
  writePage(p, "Old", "t", 0);
  tidyPages(p, ARCHIVE_AFTER + 1);
  expect(findPage(p, "Old")!.archivedAt).toBe(ARCHIVE_AFTER + 1);
  const result = writePage(p, "old", "fresh", ARCHIVE_AFTER + 2);
  expect(result).toMatchObject({ created: false, page: { text: "fresh", updatedAt: ARCHIVE_AFTER + 2 } });
  expect(findPage(p, "Old")!).not.toHaveProperty("archivedAt");
});

test("pages archive after 14 days and are deleted 90 days later", () => {
  const p = pad();
  writePage(p, "Old", "t", 0);
  writePage(p, "New", "t", 10 * DAY);
  tidyPages(p, ARCHIVE_AFTER);
  expect(p.pages.every((page) => page.archivedAt === undefined)).toBe(true);
  const archived = ARCHIVE_AFTER + 1;
  tidyPages(p, archived);
  expect(findPage(p, "Old")!.archivedAt).toBe(archived);
  expect(findPage(p, "New")!.archivedAt).toBeUndefined();
  tidyPages(p, archived + DELETE_AFTER);
  expect(findPage(p, "Old")).toBeDefined();
  tidyPages(p, archived + DELETE_AFTER + 1);
  expect(findPage(p, "Old")).toBeUndefined();
  expect(findPage(p, "New")!.archivedAt).toBeDefined(); // archived long ago itself by now, not yet deleted
});

test("the index lists active pages newest first with their age", () => {
  const p = pad();
  const now = 30 * DAY;
  expect(renderIndex(p, now)).toBeUndefined();
  writePage(p, "Software factory", "t", now - 2 * 3_600_000);
  writePage(p, "LM07", "t", now - 30_000);
  writePage(p, "Home servers", "t", now - 3 * DAY);
  writePage(p, "Gone", "t", now - 20 * DAY);
  tidyPages(p, now); // archives "Gone"
  expect(renderIndex(p, now)).toBe(
    "- LM07 (updated just now)\n- Software factory (updated 2 h ago)\n- Home servers (updated 3 d ago)",
  );
});
