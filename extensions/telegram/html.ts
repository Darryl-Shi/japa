import { Marked, type MarkedToken, type Token, type Tokens, type TokenizerExtension } from "marked";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const attribute = (text: string) => escape(text).replaceAll('"', "&quot;");

/** `||text||` as a `spoiler` token, its text lexed as inline markdown. */
const spoiler: TokenizerExtension = {
  name: "spoiler",
  level: "inline",
  start: (src) => {
    const i = src.indexOf("||");
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const match = /^\|\|(?!\s)([\s\S]*?\S)\|\|/.exec(src);
    if (match) return { type: "spoiler", raw: match[0], tokens: this.lexer.inlineTokens(match[1]!) };
  },
};

const marked = new Marked({ gfm: true, extensions: [spoiler] });

/** How the token walk writes its output: Telegram HTML, or plain text. */
interface Format {
  /** Literal text. */
  text(text: string): string;
  /** `inner` (already written) inside the tag `name`, with `attributes` (already escaped, each led by a space). */
  tag(name: string, inner: string, attributes?: string): string;
  /** A link to `href` labelled `label` (already written). */
  link(href: string, label: string): string;
}

const HTML: Format = {
  text: escape,
  tag: (name, inner, attributes = "") => `<${name}${attributes}>${inner}</${name}>`,
  link: (href, label) => `<a href="${attribute(href)}">${label}</a>`,
};

const PLAIN: Format = {
  text: (text) => text,
  tag: (_, inner) => inner,
  link: (href, label) => (label === href || `mailto:${label}` === href ? label : `${label} (${href})`),
};

/** `tokens` as blocks, a blank line apart. */
const blocks = (tokens: Token[], f: Format) =>
  tokens
    .map((t) => block(t, f))
    .filter((b) => b !== "")
    .join("\n\n");

/** A block token; "" for those that show nothing (blank lines, link definitions). */
function block(token: Token, f: Format): string {
  const t = token as MarkedToken;
  switch (t.type) {
    case "space":
    case "def":
      return "";
    case "paragraph":
      return inline(t.tokens, f);
    case "text":
      return t.tokens ? inline(t.tokens, f) : f.text(t.text);
    case "heading":
      return f.tag("b", inline(t.tokens, f));
    case "code": {
      const lang = t.lang?.split(/\s/)[0];
      const code = f.text(t.text);
      return f.tag("pre", lang ? f.tag("code", code, ` class="language-${attribute(lang)}"`) : code);
    }
    case "blockquote": {
      const inner = blocks(t.tokens, f);
      return f.tag("blockquote", inner, inner.split("\n").length > 10 ? " expandable" : "");
    }
    case "list":
      return list(t, f);
    case "table":
      return f.tag("pre", f.text(table(t)));
    case "hr":
      return "———";
    case "html":
      return f.text(t.text.replace(/\n+$/, ""));
    case "checkbox":
      return ""; // shown by the list item's marker
    default: {
      const g = token as Tokens.Generic;
      return g.tokens ? inline(g.tokens, f) : f.text(g.raw);
    }
  }
}

/** A list as one line per item (`• `, `1. `, `☐ ` or `☑ `), nested lists indented two spaces per level. */
function list(token: Tokens.List, f: Format): string {
  const start = token.start === "" ? 1 : token.start;
  return token.items
    .map((item, i) => {
      const marker = item.task ? (item.checked ? "☑ " : "☐ ") : token.ordered ? `${start + i}. ` : "• ";
      const body = item.tokens
        .map((t) => (t.type === "list" ? block(t, f).replace(/^/gm, "  ") : block(t, f)))
        .filter((b) => b !== "")
        .join("\n");
      return marker + body;
    })
    .join("\n");
}

/**
 * A table as plain text: each column padded to its longest cell (cell markdown written as plain text), cells joined
 * with " | ", and a "─" rule under the header.
 */
function table(token: Tokens.Table): string {
  const rows = [token.header, ...token.rows].map((row) => row.map((cell) => inline(cell.tokens, PLAIN)));
  const widths = token.header.map((_, i) => Math.max(...rows.map((row) => [...(row[i] ?? "")].length)));
  const lines = rows.map((row) =>
    widths.map((width, i) => (row[i] ?? "") + " ".repeat(width - [...(row[i] ?? "")].length)).join(" | "),
  );
  const rule = "─".repeat(Math.max(...lines.map((line) => [...line].length)));
  return [lines[0]!, rule, ...lines.slice(1)].map((line) => line.trimEnd()).join("\n");
}

/** Inline tokens; raw HTML and anything unknown is kept as text. */
function inline(tokens: Token[], f: Format): string {
  return tokens
    .map((token) => {
      if (token.type === "spoiler") return f.tag("tg-spoiler", inline(token.tokens!, f));
      const t = token as MarkedToken;
      switch (t.type) {
        case "text":
          return t.tokens ? inline(t.tokens, f) : f.text(t.text);
        case "escape":
          return f.text(t.text);
        case "strong":
          return f.tag("b", inline(t.tokens, f));
        case "em": {
          // `***x***` lexes as em(strong(x)); written as <b><i>x</i></b>, which looks the same.
          const only = t.tokens.length === 1 ? (t.tokens[0] as MarkedToken) : undefined;
          if (only?.type === "strong") return f.tag("b", f.tag("i", inline(only.tokens, f)));
          return f.tag("i", inline(t.tokens, f));
        }
        case "del":
          return f.tag("s", inline(t.tokens, f));
        case "codespan":
          return f.tag("code", f.text(t.text));
        case "br":
          return "\n";
        case "link":
          return f.link(t.href, inline(t.tokens, f));
        case "image":
          return f.link(t.href, f.text(t.text || t.href));
        case "checkbox":
          return ""; // shown by the list item's marker
        default:
          return f.text(token.raw);
      }
    })
    .join("");
}

/**
 * Markdown as Telegram's HTML subset (b i s code pre a blockquote tg-spoiler), written from marked's token tree so
 * tags always nest; everything else is escaped text.
 */
export const toHtml = (markdown: string) => blocks(marked.lexer(markdown), HTML);

/** Markdown as plain text: the same walk as `toHtml` with no tags (markers dropped, links as "label (url)"). */
export const toPlain = (markdown: string) => blocks(marked.lexer(markdown), PLAIN);

/**
 * How long Telegram counts `html` (written by `toHtml`): its text without tags, entities decoded, in UTF-16 code units
 * (as Telegram counts; never fewer than characters).
 */
export const visibleLength = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&").length;
