import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { inputOf, MAX_NAME_CHARS, pdfText, sanitiseName } from "../src/kernel/messaging/attachments.ts";
import { tempHome } from "./helpers.ts";

/** While set, unpdf's documents never load (an extraction that hangs). */
let hang = false;
vi.mock("unpdf", async (actual) => {
  const unpdf = await actual<typeof import("unpdf")>();
  return {
    ...unpdf,
    getDocumentProxy: (...args: Parameters<typeof unpdf.getDocumentProxy>) =>
      hang ? new Promise<never>(() => {}) : unpdf.getDocumentProxy(...args),
  };
});

const day = () => new Date().toISOString().slice(0, 10);
const dirOf = (home: string) => join(home, "attachments", day());
const bytes = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([137, 80, 78, 71]);

/** A minimal PDF, one page per entry of `pages`, each showing its text (none for `""`) in Helvetica. */
function pdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1; // 1-based object number
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // Pages, filled in below
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = pages.map((text) => {
    const content = text === "" ? "" : `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    return add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`,
    );
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytes(out);
}

test("a file is saved under its original name, after the message id, and noted with its type and size", async () => {
  const home = tempHome();
  const data = new Uint8Array(1536);
  const input = await inputOf(home, [{ id: "7", text: "here", files: [{ data, mimeType: "application/zip", name: "a.zip" }] }], true, 100);
  const path = join(dirOf(home), "7-a.zip");
  expect(input).toBe(`here\n[file saved to ${path} (application/zip, 1.5 KB)]`);
  expect(new Uint8Array(readFileSync(path))).toEqual(data);
});

test("names are sanitised: basename only, no control characters or leading dots, capped keeping the extension", () => {
  expect(sanitiseName("../../etc/passwd")).toBe("passwd");
  expect(sanitiseName("C:\\Users\\me\\report.docx")).toBe("report.docx");
  expect(sanitiseName("..hidden")).toBe("hidden");
  expect(sanitiseName("a\u0000b\nc\u007f.txt")).toBe("abc.txt");
  expect(sanitiseName("dir/")).toBe("");
  expect(sanitiseName("...")).toBe("");
  const long = sanitiseName(`${"x".repeat(300)}.pdf`);
  expect(long).toHaveLength(MAX_NAME_CHARS);
  expect(long.endsWith("x.pdf")).toBe(true);
});

test("sanitised names are what gets written, inside the day's directory", async () => {
  const home = tempHome();
  const files = [
    { data: bytes("1"), mimeType: "text/plain", name: "../../evil.txt" },
    { data: bytes("2"), mimeType: "text/plain", name: ".bashrc" },
    { data: bytes("3"), mimeType: "text/plain", name: "a\nb.txt" },
  ];
  const input = await inputOf(home, [{ id: "9", files }], false, 100);
  expect(readdirSync(dirOf(home)).sort()).toEqual(["9-ab.txt", "9-bashrc", "9-evil.txt"]);
  expect(input).toBe(
    ["9-evil.txt", "9-bashrc", "9-ab.txt"].map((f) => `[file saved to ${join(dirOf(home), f)} (text/plain, 1 B)]`).join("\n"),
  );
});

test("nameless files are named after the message, numbered from the second, with the MIME type's extension", async () => {
  const home = tempHome();
  const files = [
    { data: bytes("a"), mimeType: "audio/ogg" },
    { data: bytes("b"), mimeType: "application/x-unknown" },
    { data: bytes("c"), mimeType: "audio/mpeg", name: "/" }, // sanitises to nothing
  ];
  await inputOf(home, [{ id: "5", files }], false, 100);
  expect(readdirSync(dirOf(home)).sort()).toEqual(["5-2.bin", "5-3.mp3", "5.ogg"]);
});

test("a taken name gets a numeric suffix before the extension and nothing is overwritten", async () => {
  const home = tempHome();
  mkdirSync(dirOf(home), { recursive: true });
  writeFileSync(join(dirOf(home), "3-x.pdf"), "old");
  const files = [
    { data: bytes("one"), mimeType: "application/zip", name: "x.pdf" },
    { data: bytes("two"), mimeType: "application/zip", name: "x.pdf" },
  ];
  const input = await inputOf(home, [{ id: "3", files }], false, 100);
  expect(readFileSync(join(dirOf(home), "3-x.pdf"), "utf8")).toBe("old");
  expect(readFileSync(join(dirOf(home), "3-x-2.pdf"), "utf8")).toBe("one");
  expect(readFileSync(join(dirOf(home), "3-x-3.pdf"), "utf8")).toBe("two");
  expect(input).toContain(`[file saved to ${join(dirOf(home), "3-x-2.pdf")} (application/zip, 3 B)]`);
});

test("images go inline with vision, else the notes say the model cannot see them", async () => {
  const home = tempHome();
  const messages = [{ id: "1", text: "look", files: [{ data: PNG, mimeType: "image/png", name: "cat.png" }] }];
  const path = join(dirOf(home), "1-cat.png");
  expect(await inputOf(home, messages, true, 100)).toEqual([
    { type: "text", text: `look\n[image saved to ${path}]` },
    { type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" },
  ]);
  const blind = await inputOf(home, [{ id: "2", text: "look", files: [{ data: PNG, mimeType: "image/png" }] }], false, 100);
  expect(blind).toBe(`look\n[image saved to ${join(dirOf(home), "2.png")}]\n(this model cannot see images)`);
});

test("an image type models can't take is saved and noted, not inlined", async () => {
  const home = tempHome();
  const svg = bytes("<svg/>");
  const input = await inputOf(home, [{ id: "5", files: [{ data: svg, mimeType: "image/svg+xml", name: "a.svg" }] }], true, 100);
  expect(input).toBe(`[image saved to ${join(dirOf(home), "5-a.svg")}]`);
});

test("texts alone stay a string; a file that cannot be saved is noted with why", async () => {
  const home = tempHome();
  expect(await inputOf(home, [{ id: "1", text: "a" }, { id: "2", text: "b" }], true, 100)).toBe("a\n\nb");
  writeFileSync(join(home, "attachments"), "not a dir");
  const input = await inputOf(home, [{ id: "3", text: "hi", files: [{ data: PNG, mimeType: "image/png" }] }], true, 100);
  expect(input).toMatch(/^hi\n\[file could not be saved: .+\]$/);
});

test("a PDF's text is written next to it and inlined with its page count", async () => {
  const home = tempHome();
  const data = pdf(["Hello PDF world", "Second page"]);
  const input = (await inputOf(home, [{ id: "4", files: [{ data, mimeType: "application/pdf", name: "doc.pdf" }] }], true, 1000)) as string;
  const path = join(dirOf(home), "4-doc.pdf");
  const lines = input.split("\n");
  expect(lines[0]).toMatch(new RegExp(`^\\[file saved to ${path.replace(/[.\\]/g, "\\$&")} \\(application/pdf, \\d+ B\\)\\]$`));
  expect(lines[1]).toBe("[PDF text, 2 pages]");
  expect(input).toContain("Hello PDF world");
  expect(input).toContain("Second page");
  expect(input).not.toContain("Truncated");
  expect(readFileSync(`${path}.txt`, "utf8")).toContain("Second page");
  expect(new Uint8Array(readFileSync(path))).toEqual(data);
});

test("a PDF's text over the cap is cut, pointing at the full text", async () => {
  const home = tempHome();
  const text = "abcdefghij ".repeat(6).trim();
  const input = (await inputOf(home, [{ id: "4", files: [{ data: pdf([text]), mimeType: "application/pdf" }] }], true, 30)) as string;
  const path = join(dirOf(home), "4.pdf");
  const lines = input.split("\n");
  expect(lines.slice(1)).toEqual(["[PDF text, 1 pages]", text.slice(0, 30), `[Truncated; full text at ${path}.txt]`]);
  expect(readFileSync(`${path}.txt`, "utf8")).toBe(text);
});

test("a PDF without text says so and writes no text file", async () => {
  const home = tempHome();
  const input = await inputOf(home, [{ id: "6", files: [{ data: pdf([""]), mimeType: "application/pdf", name: "scan.pdf" }] }], true, 100);
  const path = join(dirOf(home), "6-scan.pdf");
  expect(input).toMatch(/\n\[PDF has no extractable text\]$/);
  expect(existsSync(path)).toBe(true);
  expect(existsSync(`${path}.txt`)).toBe(false);
});

test("a corrupt PDF is saved, with why its text could not be extracted", async () => {
  const home = tempHome();
  const input = await inputOf(home, [{ id: "8", files: [{ data: bytes("not a pdf at all"), mimeType: "application/pdf", name: "bad.pdf" }] }], true, 100);
  const path = join(dirOf(home), "8-bad.pdf");
  expect(input).toMatch(/\n\[PDF text could not be extracted: .+\]$/);
  expect(readFileSync(path, "utf8")).toBe("not a pdf at all");
  expect(existsSync(`${path}.txt`)).toBe(false);
});

test("a .pdf name with a generic MIME type is read as a PDF; another type with that name is not", async () => {
  const home = tempHome();
  const data = pdf(["Generic"]);
  const generic = await inputOf(home, [{ id: "1", files: [{ data, mimeType: "application/octet-stream", name: "Report.PDF" }] }], true, 100);
  expect(generic).toMatch(/\(application\/octet-stream, \d+ B\)\]\n\[PDF text, 1 pages\]\nGeneric$/);
  const zip = await inputOf(home, [{ id: "2", files: [{ data, mimeType: "application/zip", name: "x.pdf" }] }], true, 100);
  expect(zip).not.toContain("PDF text");
});

test("an extraction that takes too long times out, the file still saved", async () => {
  hang = true;
  try {
    await expect(pdfText(pdf(["slow"]), 50)).rejects.toThrow(/timed out/);
    const home = tempHome();
    const input = await inputOf(home, [{ id: "1", files: [{ data: pdf(["slow"]), mimeType: "application/pdf" }] }], true, 100, 50);
    expect(input).toMatch(/\n\[PDF text could not be extracted: timed out after 0 s\]$/);
    expect(existsSync(join(dirOf(home), "1.pdf"))).toBe(true);
  } finally {
    hang = false;
  }
});
