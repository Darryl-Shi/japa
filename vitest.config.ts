import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20000,
    execArgv: ["--disable-warning=ExperimentalWarning"], // node:sqlite is experimental in Node 24
    // Booting the packaged extensions mustn't build a real desktop, nor bind the web UI's port.
    env: { JAPA_DESKTOP_AUTOSTART: "0", JAPA_WEBUI_AUTOSTART: "0" },
  },
});
