// The `desktop` extension: japa's own computer — the container, its environment, the computer and browser tools.
import { dirname } from "node:path";
import { defineJapaExtension, type EnvironmentAdapter, type JapaExtension, type KernelContext, Type } from "../../src/sdk.ts";
import { browserTool } from "./browser.ts";
import { computerTool } from "./computer.ts";
import { type DesktopConfig, desktopContainer, dockerCli } from "./container.ts";
import { ENV_MODULE, type EnvServer, remoteEnv, SERVER, startEnvServer } from "./env.ts";
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

  let server: Promise<EnvServer> | undefined;
  let live: EnvServer | undefined;
  /** Copies the env server and pi-durable's `dist/env/` into the container, then runs it there as japa. */
  async function start() {
    await desktop.ready(true);
    for (const args of [
      ["cp", dirname(ENV_MODULE), `${config.name}:/opt/japa/`],
      ["cp", SERVER, `${config.name}:/opt/japa/env-server.ts`],
    ]) {
      const result = await config.docker(args);
      if (result.code !== 0) throw new Error(result.stderr);
    }
    return startEnvServer(["docker", "exec", "-i", "-u", "japa", config.name, "node", "/opt/japa/env-server.ts", "/opt/japa/env/node.js"]);
  }
  /** The live env server, or a new one; concurrent first calls share its start. */
  function envServer() {
    if (live?.closed) [server, live] = [undefined, undefined];
    server ??= start().then(
      (started) => (live = started),
      (error: unknown) => {
        server = undefined;
        throw error;
      },
    );
    return server;
  }
  const environment: EnvironmentAdapter = {
    name: "desktop",
    create: ({ cwd }) => remoteEnv(envServer, cwd ?? "/home/japa", `docker:${config.name}`),
  };

  return defineJapaExtension({
    name: "desktop",
    summary: "Gives me my own computer: a desktop with a browser and apps that I can see and operate",
    examples: ["log into my utility portal and download the latest bill", "what's on the desktop right now?"],
    docs: "./skills/using-the-desktop/SKILL.md",
    provides: { environment: [environment], tool: [computerTool(desktop), browser.tool] },
    durable: { hooks: [keepRecentImages] },
    secrets: ["desktop.vncPassword"],
    settings: Type.Object({
      cpus: Type.Optional(Type.Number()),
      memory: Type.Optional(Type.String()),
      shm: Type.Optional(Type.String()),
      bind: Type.Optional(Type.String()),
    }),
    status: () => (kernel ? desktop.status() : undefined),
    setup: (ctx) => {
      kernel = ctx;
      return async () => {
        desktop.dispose();
        live?.close();
        await browser.close();
      };
    },
  });
}

export default desktopExtension({ name: "japa-desktop", vncPort: 6080, cdpPort: 9222, docker: dockerCli });
