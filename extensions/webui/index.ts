// The `webui` extension: a browser chat surface, the SvelteKit app in ./app mounted on the surface's own HTTP server.
// The app's build is imported on start(), never here, so this module loads (and `japa check` passes) without it.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defineJapaExtension,
  type Dispose,
  type JapaExtension,
  type KernelContext,
  type Status,
  type Surface,
  type SurfaceContext,
  Type,
} from "japa/sdk";
import { BRIDGE_KEY, type StatusView, type WebuiBridge } from "./app/src/lib/protocol.ts";
import { generateToken } from "./auth.ts";
import { startLive } from "./live.ts";
import { type Handler, hostPort, pipeline } from "./server.ts";

export const TOKEN_SECRET = "webui.token";
const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 7337;
const BUILD_DIR = fileURLToPath(new URL("./build", import.meta.url));
/** The SvelteKit app; `npm run build` there (or at japa's root) builds it into ./build. */
const APP_DIR = fileURLToPath(new URL("./app", import.meta.url));

const bridgeSlot = globalThis as Record<symbol, WebuiBridge | undefined>;
const BRIDGE = Symbol.for(BRIDGE_KEY);

/** `path` with the user's home dir as `~`. */
function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Why listening failed, for the status line. */
function reason(error: NodeJS.ErrnoException): string {
  if (error.code === "EADDRINUSE") return "address already in use";
  if (error.code === "EACCES") return "permission denied";
  if (error.code === "EADDRNOTAVAIL") return "address not available";
  return error.message;
}

function statusView(s: Status): StatusView {
  return {
    ...(s.model && { model: { provider: s.model.provider, modelId: s.model.modelId } }),
    extensions: s.extensions.map((e) => ({
      name: e.name,
      summary: e.summary,
      provides: e.provides,
      ...(e.status !== undefined && { status: e.status }),
      ...(e.state !== undefined && { state: e.state }),
    })),
    errors: s.errors.map((e) => ({ name: e.name, error: e.error })),
  };
}

/** The extension, serving the build in `buildDir` (default ./build; tests point it elsewhere). */
export function webuiExtension(options: { buildDir?: string } = {}): JapaExtension {
  const buildDir = options.buildDir ?? BUILD_DIR;
  let kernel: KernelContext | undefined;
  let line: string | undefined;

  async function start(ctx: SurfaceContext): Promise<Dispose> {
    line = undefined;
    if (kernel === undefined) throw new Error("setup did not run");
    const settings = kernel.settings();
    // JAPA_WEBUI_AUTOSTART=0 turns it off for a process (the test suite's many daemons).
    if (settings.enabled === false || process.env.JAPA_WEBUI_AUTOSTART === "0") return () => {};
    const bind = typeof settings.bind === "string" && settings.bind !== "" ? settings.bind : DEFAULT_BIND;
    const port = typeof settings.port === "number" ? settings.port : DEFAULT_PORT;
    const k = kernel;
    if ((await k.secret(TOKEN_SECRET)) === undefined) await k.setSecret(TOKEN_SECRET, generateToken());

    const handlerPath = join(buildDir, "handler.js");
    if (!existsSync(handlerPath)) {
      line = `not built — run npm run build in ${APP_DIR}`;
      return () => {};
    }
    const { handler } = (await import(pathToFileURL(handlerPath).href)) as { handler: Handler };

    const live = await startLive(ctx);
    const bridge: WebuiBridge = {
      subscribe: (send, close) => live.subscribe(send, close),
      submit: (text, mode, id) => ctx.root.submit(text, mode, { surface: "webui", chat: "web", id }),
      abort: () => ctx.root.abort(),
      fulfil: (requestId, value) => ctx.secrets.fulfil(requestId, value),
      decline: (requestId) => ctx.secrets.decline(requestId),
      status: () => statusView(ctx.status()),
    };
    bridgeSlot[BRIDGE] = bridge;

    let bound = port;
    const server: Server = createServer(
      pipeline({ bind, port: () => bound, token: async () => (await k.secret(TOKEN_SECRET))?.trim(), handler }),
    );
    const stop = async () => {
      live.close(); // ends every open stream
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await Promise.all([closed, live.stop()]);
      if (bridgeSlot[BRIDGE] === bridge) delete bridgeSlot[BRIDGE];
    };
    try {
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, bind, resolve));
    } catch (error) {
      line = `can't listen on ${hostPort(bind, port)}: ${reason(error as NodeJS.ErrnoException)}`;
      await stop();
      return () => {};
    }
    server.on("error", () => {}); // past listening, nothing to report
    const address = server.address();
    if (address !== null && typeof address === "object") bound = address.port;
    const tokenFile = tilde(join(ctx.home, "secrets", TOKEN_SECRET));
    line = `http://${hostPort(bind, bound)} — sign in with the token in ${tokenFile}`;

    return async () => {
      line = undefined;
      await stop();
    };
  }

  const webui: Surface = { name: "webui", start };

  return defineJapaExtension({
    name: "webui",
    summary: "Chat with japa in your browser",
    provides: { surface: [webui] },
    secrets: [
      {
        name: TOKEN_SECRET,
        description: "Access token for signing in to the web UI (generated on first start if unset)",
        generated: true,
      },
    ],
    settings: Type.Object({
      bind: Type.Optional(
        Type.String({ description: 'Address the web UI listens on, e.g. a Tailscale address (default "127.0.0.1")' }),
      ),
      port: Type.Optional(Type.Integer({ description: "Port the web UI listens on (default 7337)", minimum: 0, maximum: 65535 })),
    }),
    setup: (ctx) => {
      kernel = ctx;
    },
    status: () => line,
  });
}

export default webuiExtension();
