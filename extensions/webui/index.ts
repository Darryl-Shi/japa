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
  type Surface,
  type SurfaceContext,
  Type,
} from "japa/sdk";
import { BRIDGE_KEY, type DesktopView, type WebuiBridge } from "./app/src/lib/protocol.ts";
import { generateSessionKey } from "./auth.ts";
import type { FilesMessage } from "./files.ts";
import { startLive } from "./live.ts";
import { desktopHandle, desktopProxy, type Handler, hostPort, pipeline } from "./server.ts";
import { settingsBridge } from "./settings.ts";
import { usersFile, userStore, type UsersResult } from "./users.ts";

export const SESSION_KEY_SECRET = "webui.session-key";
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

/** The Desktop panel's view: the desktop's state and its VNC password, when the desktop extension is loaded. */
async function desktopView(): Promise<DesktopView> {
  const handle = desktopHandle();
  if (handle === undefined) return { available: false };
  const { state, text } = handle.status();
  return { available: true, state, text, password: await handle.password() };
}

const ACTIVE = new Set(["queued", "running", "needs_input"]);

/** The extension, serving the build in `buildDir` (default ./build; tests point it elsewhere). */
export function webuiExtension(options: { buildDir?: string } = {}): JapaExtension {
  const buildDir = options.buildDir ?? BUILD_DIR;
  let kernel: KernelContext | undefined;
  let line: string | undefined;
  /** While listening: the status line for the users as last read, and the store to read them from. */
  let lineOf: ((users: UsersResult) => string) | undefined;
  let statusStore: ReturnType<typeof userStore> | undefined;

  async function start(ctx: SurfaceContext): Promise<Dispose> {
    line = undefined;
    lineOf = undefined;
    statusStore = undefined;
    if (kernel === undefined) throw new Error("setup did not run");
    const settings = kernel.settings();
    // JAPA_WEBUI_AUTOSTART=0 turns it off for a process (the test suite's many daemons).
    if (settings.enabled === false || process.env.JAPA_WEBUI_AUTOSTART === "0") return () => {};
    const bind = typeof settings.bind === "string" && settings.bind !== "" ? settings.bind : DEFAULT_BIND;
    const port = typeof settings.port === "number" ? settings.port : DEFAULT_PORT;
    const hosts = Array.isArray(settings.hosts) ? settings.hosts.filter((h): h is string => typeof h === "string") : [];
    const k = kernel;
    const key = await k.secret(SESSION_KEY_SECRET);
    if (key === undefined || key.trim() === "") await k.setSecret(SESSION_KEY_SECRET, generateSessionKey());

    const handlerPath = join(buildDir, "handler.js");
    if (!existsSync(handlerPath)) {
      line = `not built — run npm run build in ${APP_DIR}`;
      return () => {};
    }
    const { handler } = (await import(pathToFileURL(handlerPath).href)) as { handler: Handler };

    const live = await startLive(ctx);
    const settingsApi =
      ctx.admin === undefined
        ? undefined
        : settingsBridge(ctx.admin, ctx, { activeJobs: () => live.snapshot().jobs.filter((j) => ACTIVE.has(j.status)).length });
    const bridge: WebuiBridge = {
      subscribe: (send, close) => live.subscribe(send, close),
      submit: (text, mode, id) => ctx.root.submit(text, mode, { surface: "webui", chat: "web", id }),
      abort: () => ctx.root.abort(),
      fulfil: (requestId, value) => ctx.secrets.fulfil(requestId, value),
      decline: (requestId) => ctx.secrets.decline(requestId),
      ...(settingsApi && { settings: settingsApi }),
      desktop: desktopView,
      startDesktop: () => {
        const handle = desktopHandle();
        handle?.start();
        return handle !== undefined;
      },
    };
    bridgeSlot[BRIDGE] = bridge;

    let bound = port;
    const store = userStore(ctx.home);
    const users = () => store.load();
    const sessionKey = async () => (await k.secret(SESSION_KEY_SECRET))?.trim();
    const submitFiles = async ({ id, text, mode, files }: FilesMessage) => {
      const input = await ctx.input([{ id, text: text || undefined, files }]);
      await ctx.root.submit(input, mode, { surface: "webui", chat: "web", id });
    };
    const server: Server = createServer(
      pipeline({ bind, hosts, users, sessionKey, handler, file: (id) => live.file(id), home: ctx.home, submitFiles }),
    );
    const proxy = desktopProxy({ bind, hosts, users, sessionKey });
    server.on("upgrade", proxy.upgrade);
    const stop = async () => {
      live.close(); // ends every open stream
      proxy.close(); // and every proxied desktop connection
      settingsApi?.stop(); // and cancels the sign-ins
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
    const url = `http://${hostPort(bind, bound)}`;
    const file = tilde(usersFile(ctx.home));
    lineOf = (users) =>
      !users.ok
        ? `${url} — can't read ${file}: ${users.error}`
        : users.users.length === 0
          ? `${url} — no users yet: run japa webui users add <name>`
          : `${url} — sign in as a web UI user (${users.users.length} ${users.users.length === 1 ? "user" : "users"})`;
    statusStore = store;

    return async () => {
      line = undefined;
      lineOf = undefined;
      statusStore = undefined;
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
        name: SESSION_KEY_SECRET,
        description:
          "Key that signs web UI session cookies (generated on first start if unset; changing it signs everyone out)",
        generated: true,
      },
    ],
    settings: Type.Object({
      bind: Type.Optional(
        Type.String({ description: 'Address the web UI listens on, e.g. a Tailscale address (default "127.0.0.1")' }),
      ),
      port: Type.Optional(Type.Integer({ description: "Port the web UI listens on (default 7337)", minimum: 0, maximum: 65535 })),
      hosts: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Extra DNS names (no port) the web UI answers to, e.g. a VPN or LAN host name; localhost, the bind " +
            "address and any IP address are always accepted",
        }),
      ),
    }),
    setup: (ctx) => {
      kernel = ctx;
    },
    status: () => (lineOf !== undefined && statusStore !== undefined ? lineOf(statusStore.loadSync()) : line),
  });
}

export default webuiExtension();
