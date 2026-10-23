import { expect, test } from "vitest";
import {
  FILES_BYTES_LIMIT,
  FILES_LIMIT,
  FILES_PATH,
  checkFiles,
  errorOf,
  fileIcon,
  fileUrl,
  humanSize,
  inlineType,
  isImage,
  sameFileNames,
  sanitiseName,
} from "../extensions/webui/app/src/lib/files.ts";
import { API, MAX_FILES, MAX_FILES_BYTES } from "../extensions/webui/app/src/lib/protocol.ts";
import { humanSize as kernelHumanSize } from "../src/kernel/files.ts";
import { sanitiseName as kernelSanitiseName } from "../src/kernel/messaging/attachments.ts";

test("the app's limits and path match the protocol's", () => {
  expect(FILES_LIMIT).toBe(MAX_FILES);
  expect(FILES_BYTES_LIMIT).toBe(MAX_FILES_BYTES);
  expect(FILES_PATH).toBe(API.files);
});

test("humanSize matches the kernel's", () => {
  for (const n of [0, 1, 512, 1023, 1024, 1536, 10 * 1024 - 1, 10 * 1024, 1024 * 1024, 3.4 * 1024 * 1024, 50 * 1024 * 1024, 2 ** 40 * 3]) {
    expect(humanSize(n)).toBe(kernelHumanSize(n));
  }
  expect(humanSize(1536)).toBe("1.5 KB");
  expect(humanSize(50 * 1024 * 1024)).toBe("50 MB");
});

test("sanitiseName matches the kernel's", () => {
  const names = [
    "report.pdf",
    "  spaced name.txt  ",
    "../../etc/passwd",
    "C:\\Users\\me\\photo.png",
    ".hidden",
    "...",
    "bad\u0000\u001fname\u007f.txt",
    "x".repeat(200) + ".csv",
    "y".repeat(200),
    "",
  ];
  for (const name of names) expect(sanitiseName(name)).toBe(kernelSanitiseName(name));
  expect(sanitiseName("../a/.b.txt")).toBe("b.txt");
});

test("sameFileNames compares sanitised names in order", () => {
  expect(sameFileNames([], [])).toBe(true);
  expect(sameFileNames([{ name: " a.pdf" }], [{ name: "a.pdf" }])).toBe(true);
  expect(sameFileNames([{ name: "a.pdf" }, { name: "b.png" }], [{ name: "b.png" }, { name: "a.pdf" }])).toBe(false);
  expect(sameFileNames([{ name: "a.pdf" }], [])).toBe(false);
  // An unnamed file is named after the message id by the kernel: any name matches.
  expect(sameFileNames([{ name: "" }], [{ name: "0123abcd.png" }])).toBe(true);
});

test("checkFiles names the limit hit", () => {
  expect(checkFiles([])).toBeUndefined();
  expect(checkFiles(Array.from({ length: 10 }, () => ({ size: 1 })))).toBeUndefined();
  expect(checkFiles(Array.from({ length: 11 }, () => ({ size: 1 })))).toBe("At most 10 files per message");
  expect(checkFiles([{ size: 50 * 1024 * 1024 }])).toBeUndefined();
  expect(checkFiles([{ size: 30 * 1024 * 1024 }, { size: 20 * 1024 * 1024 + 1 }])).toBe(
    "At most 50 MB of files per message",
  );
});

test("fileUrl", () => {
  expect(fileUrl("abc-1")).toBe("/api/files/abc-1");
  expect(fileUrl("abc-1", true)).toBe("/api/files/abc-1?download=1");
  expect(fileUrl("a/b")).toBe("/api/files/a%2Fb");
});

test("image and inline types", () => {
  for (const m of ["image/jpeg", "image/png", "image/gif", "image/webp", "IMAGE/PNG; charset=x"]) {
    expect(isImage(m)).toBe(true);
    expect(inlineType(m)).toBe(true);
  }
  for (const m of ["image/svg+xml", "image/heic", "text/html", "application/octet-stream", ""]) {
    expect(isImage(m)).toBe(false);
    expect(inlineType(m)).toBe(false);
  }
  expect(isImage("application/pdf")).toBe(false);
  expect(inlineType("application/pdf")).toBe(true);
});

test("icons by type", () => {
  expect(fileIcon("image/svg+xml")).toBe("image");
  expect(fileIcon("application/pdf")).toBe("pdf");
  expect(fileIcon("text/csv")).toBe("text");
  expect(fileIcon("application/json")).toBe("text");
  expect(fileIcon("application/zip")).toBe("archive");
  expect(fileIcon("audio/mpeg")).toBe("audio");
  expect(fileIcon("video/mp4")).toBe("video");
  expect(fileIcon("application/octet-stream")).toBe("file");
  expect(fileIcon("")).toBe("file");
});

test("errorOf reads a JSON { error }", () => {
  expect(errorOf({ error: "x.pdf no longer exists on japa's host" })).toBe("x.pdf no longer exists on japa's host");
  expect(errorOf({ error: "" })).toBeUndefined();
  expect(errorOf({})).toBeUndefined();
  expect(errorOf(null)).toBeUndefined();
  expect(errorOf("nope")).toBeUndefined();
});
