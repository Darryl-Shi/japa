import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    execArgv: ["--disable-warning=ExperimentalWarning"], // node:sqlite is experimental in Node 24
    env: { JAPA_DESKTOP_AUTOSTART: "0" }, // booting the packaged extensions mustn't build a real desktop
  },
});
