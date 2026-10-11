import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

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
        "img-src": ["self", "data:"],
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
