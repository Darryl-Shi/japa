const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const attribute = (text: string) => escape(text).replaceAll('"', "&quot;");

/** Markdown as Telegram's HTML subset (b i s code pre a blockquote), everything else escaped. */
export function toHtml(markdown: string): string {
  // Code and links are rendered first and kept out of the rest, behind \0<index>\0 markers.
  const kept: string[] = [];
  const keep = (html: string) => `\0${kept.push(html) - 1}\0`;
  const text = markdown
    .replace(/^``` *(\S*).*\n([\s\S]*?)\n?^```.*$/gm, (_, lang: string, code: string) =>
      keep(lang ? `<pre><code class="language-${attribute(lang)}">${escape(code)}</code></pre>` : `<pre>${escape(code)}</pre>`),
    )
    .replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${escape(code)}</code>`))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
      keep(`<a href="${attribute(url)}">${escape(label)}</a>`),
    );
  return escape(text)
    .replace(/^&gt; ?.*(\n&gt; ?.*)*/gm, (quote) => `<blockquote>${quote.replace(/^&gt; ?/gm, "")}</blockquote>`)
    .replace(/^#{1,6} +(.*)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a?: string, b?: string) => `<b>${a ?? b}</b>`)
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/(?<!\w)([*_])(?!\s)(.+?)(?<!\s)\1(?!\w)/g, "<i>$2</i>")
    .replace(/\0(\d+)\0/g, (_, i: string) => kept[Number(i)]!);
}
