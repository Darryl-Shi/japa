// The `desktop` extension: japa's own computer — the container, the computer and browser tools.
import { defineJapaExtension, type JapaExtension, type KernelContext, Type } from "../../src/sdk.ts";
import { browserTool } from "./browser.ts";
import { computerTool } from "./computer.ts";
import { type DesktopConfig, desktopContainer, dockerCli } from "./container.ts";
import { keepRecentImages } from "./images.ts";

export function desktopExtension(config: DesktopConfig): JapaExtension {
  let kernel: KernelContext | undefined;
  const desktop = desktopContainer(config, () => kernel!);
  const connect = async () =>
    (await import("playwright-core")).chromium.connectOverCDP(`http://127.0.0.1:${config.cdpPort}`, {
      noDefaults: true,
      timeout: 10_000,
    });
  const browser = browserTool(desktop, connect);

  return defineJapaExtension({
    name: "desktop",
    summary: "Gives me my own computer: a desktop with a browser and apps that I can see and operate",
    examples: ["log into my utility portal and download the latest bill", "what's on the desktop right now?"],
    docs: "./skills/using-the-desktop/SKILL.md",
    provides: { tool: [computerTool(desktop), browser.tool] },
    durable: { hooks: [keepRecentImages] },
    secrets: [
      {
        name: "desktop.vncPassword",
        description: "Password for watching the desktop in noVNC (generated on first use if unset)",
        generated: true,
      },
    ],
    settings: Type.Object({
      cpus: Type.Optional(Type.Number({ description: "CPUs for the desktop container (default 2)" })),
      memory: Type.Optional(Type.String({ description: 'Memory limit, e.g. "4g" (default "4g")' })),
      shm: Type.Optional(Type.String({ description: 'Shared memory, e.g. "2g" (default "2g")' })),
      bind: Type.Optional(Type.String({ description: 'Address noVNC listens on (default "127.0.0.1")' })),
      autostart: Type.Optional(
        Type.Boolean({
          description: "Build and start the desktop when japa starts, rather than on first use (default true)",
          default: true,
        }),
      ),
    }),
    status: () => (kernel ? desktop.status() : undefined),
    setup: (ctx) => {
      kernel = ctx;
      // Ready before it's first needed: the image builds (minutes, once) and the container starts in the
      // background. A failure -- no Docker, say -- shows in `japa status`, and the next use tries again.
      // JAPA_DESKTOP_AUTOSTART=0 turns it off for a process (the test suite).
      if (ctx.settings().autostart !== false && process.env.JAPA_DESKTOP_AUTOSTART !== "0") {
        desktop.ready(true).catch(() => {});
      }
      return async () => {
        desktop.dispose();
        await browser.close();
      };
    },
  });
}

export default desktopExtension({ name: "japa-desktop", vncPort: 6080, cdpPort: 9222, docker: dockerCli });
