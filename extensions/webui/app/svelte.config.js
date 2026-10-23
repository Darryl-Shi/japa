import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * SvelteKit mounts a route announcer, `<div id="svelte-announcer" style="…">`, on every client-rendered page; its
 * inline style attribute is blocked by `style-src 'self'`. Allow exactly that attribute value by its hash (read from
 * the installed kit so an upgrade stays in step), rather than all inline styles. Nothing else uses style attributes.
 * @returns {("unsafe-hashes" | `sha256-${string}`)[] | undefined}
 */
function announcerStyleSources() {
  try {
    const source = readFileSync(new URL("../core/sync/write_root.js", import.meta.resolve("@sveltejs/kit")), "utf8");
    const style = /id="svelte-announcer"[^>]*?style="([^"]*)"/.exec(source)?.[1];
    if (style === undefined) return undefined;
    return ["unsafe-hashes", `sha256-${createHash("sha256").update(style).digest("base64")}`];
  } catch {
    return undefined;
  }
}
const styleSrcAttr = announcerStyleSources();

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // Mounted in-process by ../index.ts, which imports ../build/handler.js on start().
    adapter: adapter({ out: "../build", precompress: false }),
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self"],
        ...(styleSrcAttr ? { "style-src-attr": styleSrcAttr } : {}),
        // blob: the composer's and pending bubbles' thumbnails of local images (object URLs).
        "img-src": ["self", "data:", "blob:"],
        "font-src": ["self"],
        "connect-src": ["self"],
        "object-src": ["none"],
        "base-uri": ["none"],
        "form-action": ["self"],
        "frame-ancestors": ["none"],
      },
    },
  },
};
