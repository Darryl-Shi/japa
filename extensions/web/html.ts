const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " " };

const codePoint = (code: number) => (code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd");

/** The text of an HTML page: without script, style and noscript elements or tags, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^<>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (_, name: string) =>
      name.startsWith("#") ? codePoint(Number(`0${name.slice(1)}`)) : NAMED[name]!,
    )
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n\s*/g, "\n")
    .trim();
}
