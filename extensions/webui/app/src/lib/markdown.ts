// Renders assistant text as markdown, safely: raw HTML is shown as text, links are allowed only for http(s) and
// mailto, and images are never loaded. Pure TS (only `marked`), so vitest and the root tsc can import it directly.
import { Marked, type Tokens } from "marked";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML content and double- or single-quoted attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  tab: "\t",
  newline: "\n",
  nbsp: "\u00a0",
  sol: "/",
  period: ".",
  lpar: "(",
  rpar: ")",
};

/** Decodes numeric and common named character references, as a browser would in an attribute. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

const ALLOWED_LINK = new Set(["http:", "https:", "mailto:"]);
const ALLOWED_IMAGE_LINK = new Set(["http:", "https:"]);

/**
 * The URL to put in an `href`, or undefined when it isn't an absolute URL with an allowed scheme. Decided by the
 * WHATWG URL parser, which is what the browser would use, so tricks with case, entities, whitespace or control
 * characters can't smuggle another scheme through. Relative URLs are refused (they don't parse without a base).
 */
export function safeUrl(href: string, allowed: ReadonlySet<string> = ALLOWED_LINK): string | undefined {
  let url: URL;
  try {
    url = new URL(decodeEntities(href));
  } catch {
    return undefined;
  }
  return ALLOWED_LINK.has(url.protocol) && allowed.has(url.protocol) ? url.href : undefined;
}

const LINK_ATTRS = 'target="_blank" rel="noopener noreferrer"';

const md = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    // Raw HTML, block or inline, is shown as the text it is.
    html(token: Tokens.HTML | Tokens.Tag): string {
      const text = escapeHtml(token.text);
      return "block" in token && token.block ? `<p class="raw">${text.replace(/\n+$/, "")}</p>\n` : text;
    },
    // Ignore marked's `escaped` flag (set for text inside raw <script>/<pre> tags): always escape.
    text(token: Tokens.Text | Tokens.Escape): string {
      // marked leaves character references as typed (`&lt;`): decode them, so they show as what they stand for.
      return "tokens" in token && token.tokens
        ? this.parser.parseInline(token.tokens)
        : escapeHtml(decodeEntities(token.text));
    },
    code(token: Tokens.Code): string {
      const body = escapeHtml(token.text.replace(/\n$/, ""));
      return (
        '<div class="code"><button type="button" class="copy" data-copy aria-label="Copy code">Copy</button>' +
        `<pre><code>${body}</code></pre></div>\n`
      );
    },
    codespan(token: Tokens.Codespan): string {
      return `<code>${escapeHtml(token.text)}</code>`;
    },
    link(token: Tokens.Link): string {
      const inner = this.parser.parseInline(token.tokens);
      const href = safeUrl(token.href);
      if (href === undefined) return inner === "" ? escapeHtml(token.text) : inner;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(href)}"${title} ${LINK_ATTRS}>${inner}</a>`;
    },
    // Images are never loaded: an http(s) image becomes a link to it, anything else just its alt text.
    image(token: Tokens.Image): string {
      const alt = escapeHtml(token.text || "image");
      const href = safeUrl(token.href, ALLOWED_IMAGE_LINK);
      if (href === undefined) return alt;
      return `<a class="image-link" href="${escapeHtml(href)}" ${LINK_ATTRS}>${alt}</a>`;
    },
  },
});

/** Assistant markdown → safe HTML. */
export function renderMarkdown(text: string): string {
  try {
    return md.parse(text, { async: false });
  } catch {
    return `<p class="raw">${escapeHtml(text)}</p>`;
  }
}
