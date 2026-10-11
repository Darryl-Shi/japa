import { describe, expect, it } from "vitest";
import { renderMarkdown, safeUrl } from "../extensions/webui/app/src/lib/markdown.ts";

describe("webui markdown", () => {
  it("shows inline raw HTML as visible escaped text", () => {
    const html = renderMarkdown("hi <img src=x onerror=alert(1)> there");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });

  it("shows block raw HTML and scripts as text", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\n<div onclick=\"x()\">a</div>\n");
    expect(html).not.toMatch(/<script|<div onclick/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;div onclick=&quot;x()&quot;&gt;");
  });

  it("escapes text inside inline raw tags", () => {
    const html = renderMarkdown("a <script>x<y onload=1 </script> b");
    expect(html).not.toMatch(/<script|<y/);
  });

  it("does not link javascript:, data: or vbscript: URLs in any disguise", () => {
    for (const src of [
      "[x](javascript:alert(1))",
      "[x](JaVaScRiPt:alert(1))",
      "[x](&#106;avascript:alert(1))",
      "[x](&#x6A;avascript&colon;alert(1))",
      "[x](java\tscript:alert(1))",
      "[x](<javascript:alert(1)>)",
      "[x](data:text/html,<script>alert(1)</script>)",
      "[x](vbscript:msgbox(1))",
      "[x](//evil.example/x)",
      "[x](/relative)",
      "<javascript:alert(1)>",
      "[x][r]\n\n[r]: javascript:alert(1)",
    ]) {
      const html = renderMarkdown(src);
      expect(html, src).not.toContain("<a");
      expect(html, src).not.toMatch(/href/i);
    }
  });

  it("links http(s) with target and rel", () => {
    const html = renderMarkdown("[site](https://example.com/a?b=1&c=2 \"T\")");
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" title="T" target="_blank" rel="noopener noreferrer">site</a>');
  });

  it("links autolinks and bare URLs", () => {
    expect(renderMarkdown("<https://example.com>")).toContain('href="https://example.com/"');
    expect(renderMarkdown("see https://example.com/x now")).toContain('href="https://example.com/x"');
    expect(renderMarkdown("<me@example.com>")).toContain('href="mailto:me@example.com"');
  });

  it("allows mailto links", () => {
    expect(renderMarkdown("[mail](mailto:a@b.c)")).toContain('<a href="mailto:a@b.c" target="_blank" rel="noopener noreferrer">mail</a>');
  });

  it("never loads images", () => {
    const html = renderMarkdown("![a](http://evil/x.png) ![b](javascript:alert(1)) ![c](data:image/png;base64,AAAA)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="http://evil/x.png"');
    expect(html).toContain(">a</a>");
    expect(html).not.toMatch(/javascript|data:/);
  });

  it("escapes attribute-breaking characters", () => {
    const html = renderMarkdown('[x](https://e.com/"onmouseover="alert(1))');
    expect(html).not.toContain('"onmouseover=');
  });

  it("renders task lists and tables", () => {
    const tasks = renderMarkdown("- [x] done\n- [ ] todo\n");
    expect(tasks).toContain('<input checked="" disabled="" type="checkbox">');
    expect(tasks).toContain('<input disabled="" type="checkbox">');
    const table = renderMarkdown("| a | b |\n|---|:-:|\n| 1 | <b>2</b> |\n");
    expect(table).toContain("<table>");
    expect(table).toContain("<th>a</th>");
    expect(table).toContain("&lt;b&gt;2&lt;/b&gt;");
  });

  it("renders headings, quotes and emphasis", () => {
    const html = renderMarkdown("# Title\n\n> quoted **bold**\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("escapes code blocks and adds a copy button", () => {
    const html = renderMarkdown("```html\n<script>alert('x')</script>\n```\n");
    expect(html).toBe(
      '<div class="code"><button type="button" class="copy" data-copy aria-label="Copy code">Copy</button>' +
        "<pre><code>&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;</code></pre></div>\n",
    );
    expect(renderMarkdown("`<b>`")).toContain("<code>&lt;b&gt;</code>");
  });

  it("safeUrl accepts only absolute http(s)/mailto", () => {
    expect(safeUrl("https://a.b/")).toBe("https://a.b/");
    expect(safeUrl(" javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("ftp://a.b/")).toBeUndefined();
  });
});
