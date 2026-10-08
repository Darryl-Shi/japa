const CLOSE = "\n```";

/** The opening fence line of the ``` block `text` ends inside, if any. */
function openFence(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split("\n")) if (line.startsWith("```")) open = open === undefined ? line : undefined;
  return open;
}

/** Whether cutting `text` at `end` leaves a part of at most `max` characters, counting the closing fence it needs. */
const fits = (text: string, end: number, max: number) =>
  end + (openFence(text.slice(0, end)) === undefined ? 0 : CLOSE.length) <= max;

/** Where to cut `text`: the end of the first part and the start of the rest; never after a lone fence line. */
function cut(text: string, max: number): [number, number] {
  for (const separator of ["\n\n", "\n", " "]) {
    for (let i = text.lastIndexOf(separator, max); i > 0; i = text.lastIndexOf(separator, i - 1)) {
      if (fits(text, i, max) && !/^```[^\n]*$/.test(text.slice(0, i))) return [i, i + separator.length];
    }
  }
  const end = fits(text, max, max) ? max : max - CLOSE.length;
  return [end, end];
}

/**
 * `markdown` in parts of at most `max` characters, cut at paragraphs, then lines, then words, then anywhere; a ```
 * block split across parts is closed at the end of one and reopened at the start of the next.
 */
export function splitMessage(markdown: string, max: number): string[] {
  const parts: string[] = [];
  let rest = markdown;
  while (rest.length > max) {
    const [end, next] = cut(rest, max);
    const part = rest.slice(0, end);
    const fence = openFence(part);
    rest = rest.slice(next);
    if (fence === undefined) parts.push(part);
    else {
      parts.push(part + CLOSE);
      rest = `${fence}\n${rest}`;
    }
  }
  parts.push(rest);
  return parts;
}
