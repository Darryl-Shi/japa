import { defineDoc } from "@earendil-works/pi-durable";
import { estimateTokens } from "./state.ts";

/** One project or topic: its current state in free-form markdown, not a log. */
export type Page = { id: string; title: string; text: string; updatedAt: number; archivedAt?: number };
export type Scratchpad = { nextId: number; pages: Page[] };

// On the root conversation.
export const ScratchpadDoc = defineDoc<Scratchpad>({
  kind: "japa.scratchpad",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nextId: 1, pages: [] }),
});

const DAY = 86_400_000;
export const PAGE_TOKENS = 1500;
export const ACTIVE_PAGES = 15;
export const ARCHIVE_AFTER = 14 * DAY;
export const DELETE_AFTER = 90 * DAY;

/** The age of `at` at `now`: "just now", "N min ago", "N h ago", "N d ago", then the date (the window's format). */
function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} d ago` : new Date(at).toISOString().slice(0, 10);
}

const active = (pad: Scratchpad) => pad.pages.filter((p) => p.archivedAt === undefined);

/** The page titled `title`, case-insensitively, active or archived. */
export function findPage(pad: Scratchpad, title: string): Page | undefined {
  const wanted = title.toLowerCase();
  return pad.pages.find((p) => p.title.toLowerCase() === wanted);
}

/**
 * Creates the page titled `title` or replaces its text, making it active; over `PAGE_TOKENS` it is refused. When more
 * than `ACTIVE_PAGES` are then active, the least recently updated other ones are archived.
 */
export function writePage(
  pad: Scratchpad,
  title: string,
  text: string,
  now: number,
): { error: string } | { page: Page; created: boolean } {
  const tokens = estimateTokens(text);
  if (tokens > PAGE_TOKENS) {
    return {
      error: `Page too long (${tokens.toLocaleString("en-US")} tokens; max 1,500): condense it to the current state and write it again.`,
    };
  }
  let page = findPage(pad, title);
  const created = page === undefined;
  if (page === undefined) {
    page = { id: String(pad.nextId++), title, text, updatedAt: now };
    pad.pages.push(page);
  } else {
    page.text = text;
    page.updatedAt = now;
    delete page.archivedAt;
  }
  let others = active(pad).filter((p) => p !== page);
  while (others.length + 1 > ACTIVE_PAGES) {
    const oldest = others.reduce((a, b) => (b.updatedAt < a.updatedAt ? b : a));
    oldest.archivedAt = now;
    others = others.filter((p) => p !== oldest);
  }
  return { page, created };
}

/** Archives pages untouched for `ARCHIVE_AFTER` and deletes those archived for `DELETE_AFTER`. */
export function tidyPages(pad: Scratchpad, now: number): void {
  pad.pages = pad.pages.filter((p) => p.archivedAt === undefined || now - p.archivedAt <= DELETE_AFTER);
  for (const page of pad.pages) {
    if (page.archivedAt === undefined && now - page.updatedAt > ARCHIVE_AFTER) page.archivedAt = now;
  }
}

/** One line per active page, newest first: `- <title> (updated <ago>)`; undefined when there are none. */
export function renderIndex(pad: Scratchpad, now: number): string | undefined {
  const pages = active(pad).toSorted((a, b) => b.updatedAt - a.updatedAt);
  return pages.length ? pages.map((p) => `- ${p.title} (updated ${ago(p.updatedAt, now)})`).join("\n") : undefined;
}
