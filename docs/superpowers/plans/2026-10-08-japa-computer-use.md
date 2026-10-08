# Computer Use (`desktop` extension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** japa gets its own persistent, sandboxed Linux desktop in Docker. A packaged `desktop` extension provides the `desktop` environment and the `computer` (pixels) and `browser` (CDP accessibility tree) tools. `operator` jobs act on the desktop, one at a time; the CoS can only glance at it.

**Architecture:** `extensions/desktop` drives one container (`japa-desktop`) through the `docker` CLI. The container is built, created and started lazily on the first desktop call, and recreated with the same home volume when the image files or the settings change. `computer` runs `xdotool`/`xclip`/`import` through `docker exec`. `browser` drives the container's Chromium with `playwright-core` over CDP. The `desktop` environment is Pi Durable's own `NodeExecutionEnv` running inside the container, behind a small JSON-lines RPC over `docker exec -i`. A durable lock doc keeps it to one operator at a time, and a `beforeRequest` hook keeps only the 3 newest screenshots in the model context.

**Tech Stack:** TypeScript on Node 24 (type stripping, `erasableSyntaxOnly`), `@earendil-works/pi-durable` (+ `/env/node`, `/testing`), `@earendil-works/pi-ai`, `playwright-core` 1.64, Docker (Ubuntu 24.04 image, supervisord, Xvfb, XFCE, Chromium, x11vnc, noVNC), vitest with faux models and a fake `docker` runner.

**Spec:** `docs/superpowers/specs/2026-10-08-japa-computer-use-design.md`, extending `docs/superpowers/specs/2026-10-07-japa-design.md` (the main spec). The binding rulings are in `.superpowers/sdd/session-2026-10-08-rulings.md`. The code is at `c172099`: fixed `CONTRACTS`, stateless CoS, messaging and Telegram are all in.

## Plan decisions

Where the spec is ambiguous or conflicts with the code, these decide it:

1. **Lazy desktop: no Docker work at boot.** Every daemon boot activates every packaged extension: about 100 test boots, and `japa check`'s smoke boots. Boot-time Docker work would build, start or recreate the real desktop from tests. On machines without Docker it would also put an error in every test's `status().errors`. So `setup` only keeps its `KernelContext`. The first desktop call (any tool action, or a `desktop` environment call) builds the image, creates the container or starts it. As a result:
   - "Docker missing" is the answer to that call, and also the extension's line in `japa status` (decision 9). It is not an activation error.
   - The first build starts on first use.
   - `--restart unless-stopped` keeps the container up across host reboots, which replaces "start on daemon boot".
2. **During a build, an operator's call waits** for the image and then proceeds. A call from outside the desktop environment (the CoS's glance) answers `STARTING` at once. An operator has no way to "try again in a few minutes".
3. **The container's `japa.desktop.hash` label covers the image and the run arguments** (settings, mounts, password). A changed setting therefore recreates the container on the next call, on the same volume. The CoS gets the same notice as for an upgrade (`trigger.emit`, key `upgrade:<hash>`). The image keeps the spec's label (the hash of `Dockerfile` + `supervisord.conf`) and the tag `japa-desktop:<that hash>`. Recreating means `docker stop` (graceful, though Chromium commits cookies only every ~30 s, so logins from the last ~30 s may be lost), then `docker rm`, then `docker run -d`.
4. **The `desktop` environment is `NodeExecutionEnv` inside the container.** `env-server.ts` wraps it in a JSON-lines RPC. The host side (`env.ts`) is a plain object with one function per `ExecutionEnv` method. On each connection, `docker cp` copies the server and pi-durable's self-contained `dist/env/` into `/opt/japa/`. This passes `registerEnvConformance()` by construction. The unit tests run the same server as a local process, so no Docker is needed.
5. **CDP:** Chromium listens only on the container's loopback (`127.0.0.1:9222`, as the spec says). `socat` in the container forwards `:9223` to it, and the host publishes `127.0.0.1:<cdpPort>` → `9223`.
6. **Image:** Chromium comes from the `ppa:xtradeb/apps` PPA (non-snap, amd64 and arm64) and runs with `--no-sandbox`, because the container is the sandbox. Node 24 comes from NodeSource, because the env server needs Node ≥ 22.18. The base image's `ubuntu` user (uid 1000) is removed so `japa` can take uid 1000. Stale `Singleton*` profile locks are removed before Chromium starts, since a recreated container has a new hostname.
7. **Browser:**
   - Connection: `chromium.connectOverCDP(url, { noDefaults: true })`, so Chromium keeps downloading to `~/Downloads`.
   - Refs: `page.ariaSnapshot({ mode: "ai" })` and `page.getByRef(ref)`. A ref is stale when `getByRef(ref).count()` is 0, so the call doesn't wait for Playwright's 30 s timeout.
   - Downloads: `find -newermt` in `~/Downloads`.
   - Upload: CDP `DOM.setFileInputFiles` with container paths, because Playwright's `setInputFiles` reads files on the daemon's host.
   - Dialogs: each action races the page's next dialog. When a dialog opens first, the result reports it. Playwright holds the action until the `dialog` action answers it.
8. **Lock release is implicit.** A lock is free when its holder job's status is not `running` or `needs_input` (`done`, `failed`, `cancelled`, or the job is gone). A job waiting on the user, for example to finish an MFA prompt in noVNC, keeps the desktop.
9. **Kernel additions** (Task 1):
   - `KernelContext.setSecret(name, value)`, because the VNC password is generated and stored.
   - An optional manifest `status(): string | undefined`. Its line is printed under the extension in `japa status`: the noVNC URL, or the desktop's problem.
   - `desktop/` is ignored by the workspace git repo.
   - `JobDoc` and `JobsDoc` are exported from the SDK (Task 4: lock and progress).
10. **The CoS's delegation guidance lives in the two tool descriptions and the `using-the-desktop` skill**, not in the kernel's `identity.md`, which stays extension-agnostic.
11. **Test seam:** `desktopExtension(config)` builds the extension, and the default export is the production config.
    - Unit tests pass a fake `docker` runner.
    - Docker integration tests use the container `japa-desktop-test` and ports `16080`/`19222`, so they never touch a real desktop.
12. **Both tools are `executionMode: "sequential"`**, so a round's clicks and typing don't race.

## Global Constraints

- **Prime directive:** don't overcomplicate. Minimal code, no speculative options or abstractions, prefer deleting code; extensions are cheap.
- `npm test` and `npm run typecheck` pass after every task. `tsconfig` has `erasableSyntaxOnly`: no enums, no constructor parameter properties.
- `npm test` never runs Docker. Docker integration tests live in `test/desktop-docker.test.ts` inside `describe.skipIf(process.env.JAPA_DOCKER_TESTS !== "1")`.
- New dependency: `playwright-core` `^1.64.0` only (client library, no bundled browsers).
- Names: container `japa-desktop`, volume `japa-desktop-home` (`<name>-home`), image `japa-desktop:<IMAGE_HASH>`, user `japa` (uid 1000, passwordless sudo), display `:1` at `1280x800x24`, Chromium profile `/home/japa/.config/chromium`, downloads `/home/japa/Downloads`, default cwd `/home/japa`.
- Ports: noVNC `<bind>:6080` (container `6080`); CDP `127.0.0.1:9222` (container `9223` → `127.0.0.1:9222`). The container is not privileged, has no Docker socket, and no host mounts besides these two:
  - `<home>/desktop/shared` ↔ `/home/japa/shared`, read-write, host directory mode `0o777`;
  - `<home>/attachments` → `/home/japa/attachments:ro`.
- Settings (`extensions.desktop`): `cpus` (default `2`), `memory` (default `"4g"`), `shm` (default `"2g"`), `bind` (default `"127.0.0.1"`).
- Secret `desktop.vncPassword`: 16 random characters from `[A-Za-z0-9]`, generated when first needed and stored with `setSecret`.
- Values:
  - `type`: 50-character chunks, `xdotool type --delay 12`.
  - Acting `computer` actions return a screenshot taken 500 ms after they finish.
  - `wait` ≤ 30 s; `wait_for` timeout ≤ 30 s, default 10 s.
  - Snapshot, `text` and `evaluate` results are capped at 8,000 tokens (32,000 characters).
  - 3 recent images are kept.
  - The start wait is 60 s, polled every 500 ms.
  - The lock is polled every 2 s.
- Verbatim strings (spec): `This acts on the desktop — start an operator job for it.` · `The desktop is starting (building its image) — try again in a few minutes.` · `The desktop needs Docker: <reason>` · `Element <ref> is gone — take a new snapshot.` · `Waiting for the desktop (in use by job <N>)` · `[earlier screenshot omitted]`.
- Plan strings:
  - `The desktop did not start within 60 s.`
  - `The desktop could not start: <first stderr line>`
  - `The desktop image failed to build: <last stderr line>`
  - `The desktop was recreated with a new image or settings: software installed with apt is gone; everything under /home/japa is kept.`
  - `Building the desktop's image (first use or an upgrade; a few minutes).`
  - `noVNC: http://<bind>:<vncPort>/vnc.html (password: secret desktop.vncPassword)`
  - `The browser is not reachable: <reason>`
  - `The desktop connection was lost`
  - `[cut at 8,000 tokens]`
- Tool descriptions are under 1024 characters each. `workers/operator.md` and `skills/*` must not backtick `snake_case` words that aren't tool names (for example, the browser's `wait_for` action): `test/content.test.ts` checks every backticked `snake_case` word against the registered tool names.
- No approval gates.

## Review Focus

These are the cases most likely to hurt a real user. Each has a test in its owning task:

- **Docker not installed, or not usable by the daemon's user** (most installs). Boot stays clean, and every desktop call and the `japa status` line say `The desktop needs Docker: <reason>`. → Task 3 `without Docker every call says so, and so does the status line`; Task 6 `a default install loads the desktop without touching Docker`.
- **The first glance while the image builds (minutes).** The CoS gets `STARTING` at once instead of hanging, a second call does not start a second build, and an operator's call waits for the build. → Task 3 `the first call builds the image in the background…` and `an operator's call waits for the build…`.
- **An operator waiting for the user to finish MFA in noVNC (`needs_input`)** keeps the desktop: a second operator waits instead of navigating the browser away. Finished, failed and stopped holders release it. → Task 4 `a job waiting on the user keeps the desktop; a finished, failed, stopped or vanished one does not`.
- **A ref from an older snapshot** answers `Element e12 is gone — take a new snapshot.` at once, not after a 30 s timeout. → Task 5 `a stale ref answers at once`.
- **A click that opens a JavaScript alert or confirm** returns at once, reporting the dialog. The snapshot must not hang, and `dialog` answers it. → Task 5 `a dialog opened by an action is reported, and answered with dialog`.

---

## File Structure

```
extensions/desktop/index.ts            NEW  desktopExtension(config) + the default export: manifest, env-server wiring, status
extensions/desktop/container.ts        NEW  Docker runner; image build; container create/start/health/recreate; exec; status line
extensions/desktop/Dockerfile          NEW  the desktop image
extensions/desktop/supervisord.conf    NEW  Xvfb, XFCE, Chromium, CDP forwarder, x11vnc, noVNC
extensions/desktop/env.ts              NEW  the `desktop` ExecutionEnv: RPC client, isDesktop()
extensions/desktop/env-server.ts       NEW  RPC server around NodeExecutionEnv (runs in the container; locally in tests)
extensions/desktop/lock.ts             NEW  LockDoc, claimDesktop(): desktop-environment check + one-operator lock
extensions/desktop/computer.ts         NEW  the `computer` tool
extensions/desktop/browser.ts          NEW  the `browser` tool
extensions/desktop/images.ts           NEW  keepRecentImages (the durable hook)
extensions/desktop/skills/using-the-desktop/SKILL.md   NEW
workers/operator.md                    NEW
src/kernel/contracts.ts, extension.ts, boot.ts, status.ts, workspace.ts   setSecret, status line, desktop/ ignored
src/sdk.ts                             + JobDoc, JobsDoc
package.json, package-lock.json        + playwright-core
skills/building-extensions/SKILL.md, README.md, docs/superpowers/specs/2026-10-07-japa-design.md
test/desktop-helpers.ts                NEW  PNG, fakeDocker, stubKernel, testConfig, fakeDesktop, fakeApi, run, resultText, fakePage, fakeBrowser
test/desktop-env.test.ts, test/desktop-container.test.ts, test/desktop-computer.test.ts,
test/desktop-browser.test.ts, test/desktop.test.ts, test/desktop-docker.test.ts      NEW
```

Until Task 6 adds `index.ts`, the loader skips `extensions/desktop/`, because it only loads `<dir>/index.ts`. The typechecker still covers the files.

---

### Task 1: Kernel: store a secret, show a status line, ignore `desktop/`

**Files:**
- Modify: `src/kernel/contracts.ts` (`KernelContext.setSecret`, `Status.extensions[].status`), `src/kernel/extension.ts` (`JapaExtension.status`), `src/kernel/boot.ts` (`kernel().setSecret`, `status()`), `src/kernel/status.ts`, `src/kernel/workspace.ts` (`IGNORED`), `skills/building-extensions/SKILL.md`
- Test: `test/secret-requests.test.ts`, `test/boot.test.ts`, `test/messaging-menu.test.ts`, `test/workspace.test.ts`, `test/content.test.ts`

**Interfaces:**
- Produces:
  - `KernelContext.setSecret(name: string, value: string): Promise<void>` writes through the opened secrets store. For a name not in the manifest's `secrets`, it rejects with the same error as `secret` (`Extension <ext> did not declare secret "<name>"`).
  - `JapaExtension.status?: () => string | undefined` is called on every `status()`.
  - `Status.extensions[i].status?: string` is set when the extension has `status` (the value may be undefined).
  - `statusText` prints `    <status>` (4 spaces) on the line after `  <name> — <summary>` when it is set.
  - `IGNORED` gains `"desktop/"`, appended to existing workspaces by the current `ensureWorkspace` logic.

- [ ] **Step 1: Write the failing tests**

In `test/secret-requests.test.ts`, inside `describe("extensions")` (the `svc` extension):

```ts
test("an extension stores a declared secret and reads it back", async () => {
  await kernel().setSecret("svc.token", "v1");
  expect(await kernel().secret("svc.token")).toBe("v1");
  await expect(kernel().setSecret("other", "x")).rejects.toThrow('Extension svc did not declare secret "other"');
});
```

In `test/boot.test.ts`:

```ts
test("an extension's status line is shown under it, read each time", async () => {
  let line = "starting";
  const { daemon } = await bootTest({}, [{ name: "lit", summary: "Lit", status: () => line }]);
  expect(daemon.status().extensions).toContainEqual({ name: "lit", summary: "Lit", provides: [], status: "starting" });
  line = "ready";
  expect(statusText(daemon.status())).toContain("  lit — Lit\n    ready");
  await daemon.close();
});
```

In `test/messaging-menu.test.ts` (`/status shows what japa status prints`):

```ts
expect(statusText({ model: { provider: "p", modelId: "m" }, extensions: [{ name: "a", summary: "A", provides: [], status: "up" }], errors: [] }))
  .toBe("model: p/m\nextensions:\n  a — A\n    up");
```

In `test/workspace.test.ts`, `appending to a .gitignore…` also expects `lines` to contain `"desktop/"`. In `test/content.test.ts`, the building-extensions test's list becomes `["root.replies", "secretProvided", "requestSecret", "setSecret", "japa status"]`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/secret-requests.test.ts test/boot.test.ts test/messaging-menu.test.ts test/workspace.test.ts test/content.test.ts`
Expected: FAIL. `setSecret` is not a function, there is no `status` in `Status`, there is no `desktop/` line, and the skill lacks `setSecret`.

- [ ] **Step 3: Implement**

`boot.ts`: `setSecret: async (name, value) => { declared(extension, name); await secrets.set(name, value); }`; `status()` maps each extension to `{ name, summary, provides, ...(e.status && { status: e.status() }) }`.

In the skill, the manifest section gains `` `status`: optional `() => string | undefined`, a short line shown under the extension in `japa status` ``. The `KernelContext` section gains `` `setSecret(name, value)` stores a secret named in your manifest (for one you generate yourself) ``.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src skills test
git commit -m "feat(kernel): extensions can store a secret and show a status line"
```

---

### Task 2: The `desktop` environment over RPC

**Files:**
- Create: `extensions/desktop/env.ts`, `extensions/desktop/env-server.ts`, `test/desktop-env.test.ts`

**Interfaces:**
- Produces (in `env.ts`):
  - `type EnvServer = { call(target: { cwd: string } | { handle: number }, method: string, args: unknown[], context: Context): Promise<unknown>; readonly closed: boolean; close(): void }`.
  - `startEnvServer(command: string[]): EnvServer` spawns `command` with stdio `["pipe", "pipe", "pipe"]`, keeps the last stderr line, and `close()` kills it.
  - `remoteEnv(server: () => Promise<EnvServer>, cwd: string, id: string): ExecutionEnv` returns a plain object: `id`, a settable `cwd`, and one function per `ExecutionEnv` method name, listed explicitly. There is no Proxy: the object must not look thenable.
  - `isDesktop(env: ExecutionEnv | undefined): boolean` is true only for objects made by `remoteEnv` (a module `WeakSet`).
  - `LOST = "The desktop connection was lost"`.
  - `ENV_MODULE` is the host path of pi-durable's `dist/env/node.js` (`createRequire(import.meta.url).resolve("@earendil-works/pi-durable/env/node")`).
  - `SERVER` is the path of `env-server.ts`.
- `env-server.ts` is run as `node env-server.ts <path of env/node.js>`. It imports only `node:` built-ins and, dynamically, `process.argv[2]` (typed `typeof import("@earendil-works/pi-durable/env/node")`), and exits when stdin ends.

Wire protocol: one JSON object per line.

```
host → server   { id, cwd, method, args, aborted? }       env method on a fresh NodeExecutionEnv({ cwd })
host → server   { id, handle, method, args, aborted? }    method of a kept handle
host → server   { cancel: id }                            the request's context was aborted
server → host   { id, call: [...] }                       a callback argument was called (exec onOutput, watch onChange)
server → host   { id, result }                            the return value
server → host   { id, thrown: message }                   the method threw
Encoding, both ways, recursive:
  Uint8Array                 ↔ { $bytes: <base64> }
  FileError / ExecutionError ↔ { $error: "FileError" | "ExecutionError", code, message, path?, spillPath? }
  host function argument     → { $callback: true }; the server passes a function that sends { id, call }
  the server's context among a callback's arguments → { $context: true }; the host passes the request's context
  an object with a function-valued property (readers, watchers) → the server keeps it and sends
      { $handle: n, methods: [names], ...its other own properties (e.g. mode) };
      the host builds an object of those methods, each sending a handle request; a handle is dropped after its `close`
Context: the host drops each method's last argument (the Context) and sends { cancel: id } when its abortSignal fires
  (aborted: true when it already has); the server passes { abortSignal } of a per-request AbortController.
Callbacks of a request are dropped with its result, except `watch`'s, which stay until the connection closes.
Failures resolve as results, never throws: a lost connection (pending and later calls), a rejected `server()` and a
  `thrown` answer give err(new ExecutionError("unknown", msg)) for `exec` and err(new FileError("unknown", msg)) otherwise.
  msg is LOST (plus ": <last stderr line>" when there is one), the rejection's message, or the thrown message.
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/desktop-env.test.ts
const server = startEnvServer([process.execPath, SERVER, ENV_MODULE]);
afterAll(() => server.close());

registerEnvConformance({ describe, expect, it }, "desktop environment (local server)", async (use) => {
  const dir = mkdtempSync(join(tmpdir(), "japa-env-"));
  try {
    await use(remoteEnv(async () => server, dir, "test"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only desktop environments are marked", () => {
  expect(isDesktop(remoteEnv(async () => server, "/", "test"))).toBe(true);
  expect(isDesktop(new NodeExecutionEnv({ cwd: "/" }))).toBe(false);
  expect(isDesktop(undefined)).toBe(false);
});

test("calls on a lost connection fail with the lost message", async () => {
  const doomed = startEnvServer([process.execPath, "-e", "process.exit(3)"]);
  const env = remoteEnv(async () => doomed, tmpdir(), "test");
  expect(await env.readTextFile("x", ctx)).toMatchObject({ ok: false, error: { code: "unknown", message: expect.stringContaining(LOST) } });
  const ran = await env.exec("true", undefined, ctx);
  expect(ran.ok ? undefined : ran.error).toBeInstanceOf(ExecutionError);
});

test("a server that can't be reached answers with the reason", async () => {
  const env = remoteEnv(async () => { throw new Error("The desktop needs Docker: x"); }, "/", "test");
  expect(await env.exists("/", ctx)).toMatchObject({ ok: false, error: { message: "The desktop needs Docker: x" } });
});
```

(`registerEnvConformance` from `@earendil-works/pi-durable/testing`; `ctx` = `BACKGROUND_CONTEXT`.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/desktop-env.test.ts`
Expected: FAIL, because `extensions/desktop/env.ts` does not exist.

- [ ] **Step 3: Implement `env-server.ts` and `env.ts` per the protocol above**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS, every conformance case included.

- [ ] **Step 5: Commit**

```bash
git add extensions/desktop test/desktop-env.test.ts
git commit -m "feat(desktop): an ExecutionEnv served by NodeExecutionEnv over JSON-lines RPC"
```

---

### Task 3: The container and its image

**Files:**
- Create: `extensions/desktop/container.ts`, `extensions/desktop/Dockerfile`, `extensions/desktop/supervisord.conf`, `test/desktop-helpers.ts`, `test/desktop-container.test.ts`, `test/desktop-docker.test.ts`

**Interfaces:**
- Consumes: `KernelContext.setSecret` (Task 1), `settings()`, `secret()`, `trigger.emit`, `home`.
- Produces (in `container.ts`):
  - `type ExecResult = { code: number; stdout: Buffer; stderr: string }`.
  - `type Docker = (args: string[], options?: { input?: string; signal?: AbortSignal }) => Promise<ExecResult>`. It rejects only when `docker` can't be started.
  - `dockerCli: Docker` spawns `docker`; on spawn error `ENOENT` it rejects with `Error("the docker command was not found")`, otherwise with the error's message. `input` goes to stdin, and `signal` kills the process.
  - `type DesktopConfig = { name: string; vncPort: number; cdpPort: number; docker: Docker }`.
  - `type Desktop = { ready(wait: boolean): Promise<void>; exec(argv: string[], input?: string): Promise<ExecResult>; status(): string; dispose(): void }`.
  - `desktopContainer(config: DesktopConfig, kernel: () => KernelContext): Desktop`.
  - `IMAGE_HASH`: the first 12 hex characters of the sha256 of `Dockerfile`'s bytes followed by `supervisord.conf`'s bytes.
  - `DESKTOP_DIR`: this directory, the build context.
  - `STARTING`, `BUILDING`, `UPGRADED`, `NOT_STARTED`, `needsDocker(reason)`, `couldNotStart(line)` and `buildFailed(line)`, all as in Global Constraints.
  - `exec(argv, input?)` runs `docker exec [-i] -u japa <name> ...argv`, with `-i` only when there is input, and returns the result as is.
  - `status()` gives:
    - `BUILDING` while a build runs;
    - otherwise the last failure (problem or failed build);
    - otherwise the noVNC line with the current `bind` (default `127.0.0.1`) and `vncPort`.
  - `dispose()` aborts a running build.
- Produces (in `test/desktop-helpers.ts`):
  - `PNG = Buffer.from("fake png")`.
  - `testConfig(docker: Docker): DesktopConfig` returns `{ name: "japa-desktop", vncPort: 6080, cdpPort: 9222, docker }`.
  - `stubKernel(settings: JsonObject = {})` returns `{ kernel: KernelContext; home: string; settings: JsonObject; secrets: Record<string, string>; emitted: { key: string; text: string }[] }`. Its home is a `tempHome()`; `settings()` returns the same mutable object; `secret` and `setSecret` use `secrets`; `trigger.emit` pushes to `emitted`.
  - `fakeDocker()` returns `{ docker, calls: string[][], inputs: (string | undefined)[], state: { image: boolean; container?: { running: boolean; hash: string } }, holdBuild(): () => void, reply(match: (args: string[]) => boolean, result: Partial<ExecResult> | Error): void }`. It is stateful:
    - `container inspect` answers from `state`: stdout `"<running> <hash>"`, or code 1 with stderr `Error: No such container: <name>`.
    - `image inspect` answers code 0 when `state.image`, else code 1.
    - `build` sets `state.image`, waiting first when held.
    - `run` sets `state.container` to `{ running: true, hash: <value of its --label japa.desktop.hash=> }`.
    - `start`, `stop` and `rm` update `state`.
    - `exec` of `import` returns `PNG`; `exec` of `xdotool getmouselocation…` returns `X=1\nY=2\nSCREEN=0\nWINDOW=3\n`.
    - Everything else returns code 0 with empty output.
    - `reply` overrides (newest first). A reply that is an `Error` makes the call reject.

`ready(wait)`:

```
loop:
  if failed:     problem = failed; failed = undefined; throw Error(problem)       // a failed build is reported once
  if building:   if !wait throw Error(STARTING); await building; continue
  if await serialized(bringUp) === "build": continue                              // bringUp started `building`
  return

bringUp():                                                                      // one at a time
  args = [--name <name>, --restart unless-stopped, --cpus <cpus ?? 2>, --memory <memory ?? 4g>, --shm-size <shm ?? 2g>,
          -p <bind ?? 127.0.0.1>:<vncPort>:6080, -p 127.0.0.1:<cdpPort>:9223, -v <name>-home:/home/japa,
          -v <home>/desktop/shared:/home/japa/shared, -v <home>/attachments:/home/japa/attachments:ro,
          -e VNC_PASSWORD=<secret, or 16 random [A-Za-z0-9] stored with setSecret>, <name>:<IMAGE_HASH>]
  hash = first 12 hex of sha256(JSON.stringify(args))
  docker container inspect --format '{{.State.Running}} {{index .Config.Labels "japa.desktop.hash"}}' <name>
    rejects → problem = needsDocker(error.message); throw.   code ≠ 0, stderr not /No such (object|container)/i →
    problem = needsDocker(first stderr line); throw.   otherwise problem = undefined
  found, label == hash:  if not running: docker start <name>; healthy().   return
  docker image inspect <name>:<IMAGE_HASH> fails → building = build(); return "build"
  if found: docker stop <name>; docker rm <name>
  mkdir -p <home>/desktop/shared (chmod 0o777) and <home>/attachments
  docker run -d --label japa.desktop.hash=<hash> ...args
  if found: kernel().trigger.emit({ key: `upgrade:${hash}`, text: UPGRADED })
  healthy()
  (a start/stop/rm/run with code ≠ 0 throws couldNotStart(first stderr line), recorded in problem)

build(): docker build -t <name>:<IMAGE_HASH> --label japa.desktop.hash=<IMAGE_HASH> <DESKTOP_DIR>, aborted by dispose;
  code ≠ 0 → failed = buildFailed(last non-empty stderr line); finally building = undefined
healthy(): every 500 ms, up to 60 s: exec(["xdotool", "getmouselocation"]) and exec(["curl", "-sf", "http://127.0.0.1:9222/json/version"]);
  both code 0 → return. At 60 s: X answers → return (browser reports CDP itself); else problem = NOT_STARTED; throw
```

Image (`Dockerfile`), multi-arch through arch-neutral sources only:
- `FROM ubuntu:24.04`; `ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 DISPLAY=:1`; `userdel -r ubuntu`.
- `add-apt-repository -y ppa:xtradeb/apps` (Chromium) and NodeSource `setup_24.x`. Then `apt-get install --no-install-recommends`: `xvfb xfce4 xfce4-terminal dbus-x11 x11vnc novnc websockify supervisor socat chromium xdotool xclip imagemagick libreoffice atril python3 nodejs git curl unzip ffmpeg sudo fonts-noto fonts-noto-cjk fonts-noto-color-emoji ca-certificates`.
- `useradd -m -u 1000 -s /bin/bash japa`, plus `/etc/sudoers.d/japa` with `japa ALL=(ALL) NOPASSWD:ALL`. Create `/home/japa/Downloads` and `/home/japa/.config`, owned by japa.
- `mkdir -p /opt/japa` and `{"type":"module"}` in `/opt/japa/package.json` (Task 6 copies the env server there).
- `COPY supervisord.conf /etc/supervisor/conf.d/japa.conf`; `CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]`.

`supervisord.conf`: every program runs as `user=japa` with `environment=HOME="/home/japa",USER="japa",DISPLAY=":1"`, `autorestart=true`, and a high `startretries` (the programs that need X restart until it is up):

| program | command |
|---|---|
| xvfb | `Xvfb :1 -screen 0 1280x800x24 -nolisten tcp -s 0` |
| xfce | `dbus-launch --exit-with-session startxfce4` |
| chromium | `bash -c "rm -f /home/japa/.config/chromium/Singleton*; exec chromium --no-sandbox --no-first-run --no-default-browser-check --password-store=basic --start-maximized --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=/home/japa/.config/chromium"` |
| cdp | `socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222` |
| x11vnc | `x11vnc -display :1 -forever -shared -localhost -rfbport 5900 -passwd %(ENV_VNC_PASSWORD)s` |
| novnc | `websockify --web /usr/share/novnc 6080 localhost:5900` |

- [ ] **Step 1: Write the failing tests**

```ts
// test/desktop-container.test.ts
function setup(settings: JsonObject = {}) {
  const fake = fakeDocker();
  const stub = stubKernel(settings);
  return { fake, stub, desktop: desktopContainer(testConfig(fake.docker), () => stub.kernel) };
}

test("the first call builds the image in the background and answers that the desktop is starting", async () => {
  const { fake, desktop } = setup();
  fake.state.image = false;
  const release = fake.holdBuild();
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  expect(fake.calls.filter((c) => c[0] === "build")).toEqual([
    ["build", "-t", `japa-desktop:${IMAGE_HASH}`, "--label", `japa.desktop.hash=${IMAGE_HASH}`, DESKTOP_DIR]]);
  expect(desktop.status()).toBe(BUILDING);
  release();
});

test("an operator's call waits for the build, then the container is created and started", async () => {
  // state.image = false, build held; ready(true) still pending after 50 ms with no `run` call; release; it resolves
  expect(fake.state.container).toMatchObject({ running: true });
});

test("the container gets the limits, ports, mounts and a generated VNC password", async () => {
  const { fake, stub, desktop } = setup({ cpus: 4, memory: "8g", shm: "1g", bind: "100.64.0.1" });
  await desktop.ready(false);
  const password = stub.secrets["desktop.vncPassword"]!;
  expect(password).toMatch(/^[A-Za-z0-9]{16}$/);
  expect(fake.calls.find((c) => c[0] === "run")).toEqual(["run", "-d", "--label", expect.stringMatching(/^japa\.desktop\.hash=[0-9a-f]{12}$/),
    "--name", "japa-desktop", "--restart", "unless-stopped", "--cpus", "4", "--memory", "8g", "--shm-size", "1g",
    "-p", "100.64.0.1:6080:6080", "-p", "127.0.0.1:9222:9223", "-v", "japa-desktop-home:/home/japa",
    "-v", `${stub.home}/desktop/shared:/home/japa/shared`, "-v", `${stub.home}/attachments:/home/japa/attachments:ro`,
    "-e", `VNC_PASSWORD=${password}`, `japa-desktop:${IMAGE_HASH}`]);
  expect(existsSync(join(stub.home, "desktop/shared"))).toBe(true);
  expect(desktop.status()).toBe("noVNC: http://100.64.0.1:6080/vnc.html (password: secret desktop.vncPassword)");
  // with no settings: "--cpus", "2", "--memory", "4g", "--shm-size", "2g", "-p", "127.0.0.1:6080:6080"
});

test("a current container is used as is; a stopped one is started and checked", async () => {
  await desktop.ready(false);
  fake.calls.length = 0;
  await desktop.ready(false);
  expect(fake.calls.map((c) => c[0])).toEqual(["container"]);
  fake.state.container!.running = false;
  fake.calls.length = 0;
  await desktop.ready(false);
  expect(fake.calls.map((c) => c[0])).toEqual(["container", "start", "exec", "exec"]);
});

test("a changed setting or image recreates the container on the same volume and tells the chief of staff", async () => {
  await desktop.ready(false);
  stub.settings.bind = "100.64.0.1";
  fake.calls.length = 0;
  await desktop.ready(false);
  expect(fake.calls.map((c) => c[0])).toEqual(["container", "image", "stop", "rm", "run", "exec", "exec"]);
  expect(fake.calls.find((c) => c[0] === "run")).toContain("japa-desktop-home:/home/japa");
  expect(stub.emitted).toEqual([{ key: `upgrade:${fake.state.container!.hash}`, text: UPGRADED }]);
  fake.state.container!.hash = "0123456789ab"; // made from older image files
  await desktop.ready(false);
  expect(stub.emitted).toHaveLength(2);
});

test("without Docker every call says so, and so does the status line", async () => {
  fake.reply(() => true, new Error("the docker command was not found"));
  await expect(desktop.ready(false)).rejects.toThrow("The desktop needs Docker: the docker command was not found");
  expect(desktop.status()).toBe("The desktop needs Docker: the docker command was not found");
  // second setup(): container inspect answers code 1 with stderr
  // "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n"
  // → rejects "The desktop needs Docker: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"
});

test("a failed build is reported once, then built again", async () => {
  fake.state.image = false;
  fake.reply((a) => a[0] === "build", { code: 1, stderr: "#5 ERROR\nE: Unable to locate package nope\n" });
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  await vi.waitFor(() => expect(desktop.status()).toBe("The desktop image failed to build: E: Unable to locate package nope"));
  await expect(desktop.ready(false)).rejects.toThrow("The desktop image failed to build: E: Unable to locate package nope");
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  expect(fake.calls.filter((c) => c[0] === "build")).toHaveLength(2);
});

test("exec runs as japa inside the container", async () => {
  await desktop.exec(["xdotool", "getmouselocation"]);
  await desktop.exec(["xclip", "-i"], "hi");
  expect(fake.calls.slice(-2)).toEqual([
    ["exec", "-u", "japa", "japa-desktop", "xdotool", "getmouselocation"],
    ["exec", "-i", "-u", "japa", "japa-desktop", "xclip", "-i"]]);
  expect(fake.inputs.at(-1)).toBe("hi");
});

test("dockerCli reports a missing docker command", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    await expect(dockerCli(["version"])).rejects.toThrow("the docker command was not found");
  } finally {
    process.env.PATH = path;
  }
});
```

```ts
// test/desktop-docker.test.ts. Task 7 adds to this describe.
const config = { name: "japa-desktop-test", vncPort: 16080, cdpPort: 19222, docker: dockerCli };
describe.skipIf(process.env.JAPA_DOCKER_TESTS !== "1")("the desktop on Docker", () => {
  const stub = stubKernel();
  const desktop = desktopContainer(config, () => stub.kernel);
  beforeAll(() => desktop.ready(true), 30 * 60_000);
  afterAll(async () => {
    desktop.dispose();
    await dockerCli(["rm", "-f", config.name]);
    await dockerCli(["volume", "rm", `${config.name}-home`]);
  }, 60_000);

  test("the image builds, the container starts, and a screenshot is a 1280×800 PNG", async () => {
    const shot = await desktop.exec(["import", "-window", "root", "png:-"]);
    expect(shot.stdout.subarray(1, 4).toString()).toBe("PNG");
    expect([shot.stdout.readUInt32BE(16), shot.stdout.readUInt32BE(20)]).toEqual([1280, 800]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/desktop-container.test.ts test/desktop-docker.test.ts`
Expected: FAIL, because `container.ts` does not exist. The Docker suite is skipped.

- [ ] **Step 3: Implement `container.ts`, `Dockerfile`, `supervisord.conf` and the helpers**

- [ ] **Step 4: Run the unit tests, then the image on Docker**

Run: `npm test && npm run typecheck`
Expected: PASS.

Run: `JAPA_DOCKER_TESTS=1 npx vitest --run test/desktop-docker.test.ts`
Expected: PASS. The first run builds the image, which takes minutes. Fix the Dockerfile or `supervisord.conf` until it passes.

- [ ] **Step 5: Commit**

```bash
git add extensions/desktop test
git commit -m "feat(desktop): the desktop image and container lifecycle"
```

---

### Task 4: The lock and the `computer` tool

**Files:**
- Create: `extensions/desktop/lock.ts`, `extensions/desktop/computer.ts`, `test/desktop-computer.test.ts`
- Modify: `src/sdk.ts` (export `JobDoc`, `JobsDoc`), `test/desktop-helpers.ts`

**Interfaces:**
- Consumes: `isDesktop`, `remoteEnv` (Task 2); `Desktop`, `ExecResult` (Task 3); `JobDoc`, `JobsDoc`, `defineDoc`, `ROOT_CONVERSATION_ID` from the SDK.
- Produces (in `lock.ts`):
  - `LockDoc = defineDoc<{ job?: string }>({ kind: "japa.desktop-lock", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}) })`, kept on the root.
  - `OPERATOR`; `waiting(job: string): string`.
  - `claimDesktop(api: ToolExecutionApi, context: Context): Promise<string | undefined>`:
    - Outside a desktop environment it returns `OPERATOR` and does nothing else.
    - Otherwise it loops on one `api.commit`, in which:
      - `me` is `(await tx.doc(JobDoc, api.conversationId)).jobId`;
      - the holder `h` is `LockDoc.job`;
      - if `h` is set, `h !== me`, and `jobs[h]?.status` is `running` or `needs_input`, it sets `jobs[me].progress = waiting(h)` and `updatedAt` (only on the first round) and returns `h`;
      - otherwise it sets `LockDoc.job = me` and returns undefined.
    - On `h`, it sleeps 2 s, aborted by `context.abortSignal` (the rejection propagates), and loops.
- Produces (in `computer.ts`): `computerTool(desktop: Desktop): ToolRegistration` and `COMPUTER_READS = ["screenshot", "zoom", "cursor_position", "clipboard_get"]`.
  - The tool:
    - Name `computer`, `executionMode: "sequential"`.
    - Parameters (all optional except `action`): `action`, `x`, `y`, `region`, `button`, `count` (1–3), `modifiers`, `path` (≥ 2 points), `direction`, `amount`, `text`, `combo`, `hold`, `seconds` (≤ 30), `screenshot`. Enums use `StringEnum` from pi-ai.
    - Description, verbatim: `Operate japa's desktop (1280×800 Linux, XFCE) with mouse and keyboard; coordinates are screen pixels. Read actions work anywhere: screenshot, zoom { region: [x1, y1, x2, y2] }, cursor_position, clipboard_get. Every other action needs an operator job — from the chief of staff, start one: click { x, y, button?, count?, modifiers? }, mouse_down / mouse_up { x, y, button? }, move { x, y }, drag { path: [[x, y], …] }, scroll { x, y, direction, amount }, type { text }, key { combo (xdotool syntax, e.g. ctrl+l, Return), hold? }, wait { seconds ≤ 30 }, clipboard_set { text }. Acting actions return a screenshot unless screenshot is false. For web pages, prefer the browser tool.`
  - `execute`:
    1. An acting action first runs `claimDesktop` and returns its refusal as the text result.
    2. `await desktop.ready(isDesktop(api.env))`; a throw becomes the text result.
    3. It runs the action's commands below in order, each its own `desktop.exec`.
  - Commands, with buttons `left`=1, `middle`=2, `right`=3, scroll `up`/`down`/`left`/`right` = 4/5/6/7, defaults button left, count 1:
    - click: `xdotool mousemove x y`; when modifiers, `xdotool keydown <mods joined by +>`; `xdotool click --repeat <count> <b>`; when modifiers, `xdotool keyup <mods>`.
    - mouse_down / mouse_up: `mousemove x y`, then `mousedown <b>` / `mouseup <b>`.
    - move: `mousemove x y`.
    - drag: `mousemove x0 y0`, `mousedown 1`, `mousemove xi yi` for each later point, `mouseup 1`.
    - scroll: `mousemove x y`, then `click --repeat <amount> <4–7>`.
    - type: `xdotool type --delay 12 -- <chunk>` per 50 characters (argv, no shell).
    - key: `xdotool key -- <combo>`; with `hold`, `keydown -- <combo>`, wait `hold` s on the host, then `keyup -- <combo>`.
    - wait: a host sleep.
    - clipboard_set: `sh -c "xclip -selection clipboard -i >/dev/null 2>&1"` with `text` as input.
    - clipboard_get: `xclip -selection clipboard -o`.
    - cursor_position: `xdotool getmouselocation --shell`.
    - screenshot: `import -window root png:-`.
    - zoom: `import -window root -crop <x2-x1>x<y2-y1>+<x1>+<y1> +repage -resize 1280x800 png:-`.
  - Results:
    - Image results (screenshot, zoom, and acting actions unless `screenshot: false`) are `[{ type: "text", text: "<action> — cursor at <x>,<y>" }, { type: "image", data: <base64>, mimeType: "image/png" }]`. Acting actions sleep 500 ms first; the screenshot is taken before the cursor (`getmouselocation --shell`).
    - `screenshot: false` returns only that text line.
    - cursor_position: `cursor at <x>,<y>`.
    - wait: `waited <seconds> s`.
    - clipboard_get: its output.
    - A command with code ≠ 0: `<action> failed: <first stderr line, or "exit code <n>">`.
    - A missing parameter: `<action> needs <names joined by " and ">`, e.g. `click needs x and y`.
- Produces (in `test/desktop-helpers.ts`):
  - `fakeDesktop()` returns `{ desktop: Desktop; calls: { argv: string[]; input?: string }[]; waits: boolean[]; reply(match: (argv: string[]) => boolean, result: Partial<ExecResult>): void }`. `ready` records its `wait`. Its `exec` replies like `fakeDocker`'s, and `xclip … -o` answers `copied`.
  - `fakeApi({ desktop = true, conversationId = 7, job = "1", docs = {} } = {})` returns `{ api: ToolExecutionApi; docs }`. `docs` is keyed `<kind>:<conversationId>`, seeded with `japa.job:<conversationId>` = `{ jobId: job, environment: "desktop" }` and, unless present, `japa.jobs:1` = `{ nextId: 2, jobs: { [job]: { id: job, status: "running" } } }`. `commit(change)` runs `change` on a tx whose `doc(token, id)` is `docs[key] ??= token.definition.initial()`. `env` is `remoteEnv(…)` (never called) when `desktop` is true, else undefined. Two `fakeApi`s can share `docs`.
  - `run(tool, args, api, signal?)` calls `tool.execute(args, api, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT)`.
  - `resultText(result)` joins the text parts.

- [ ] **Step 1: Write the failing tests**

```ts
const SHOT = [["import", "-window", "root", "png:-"], ["xdotool", "getmouselocation", "--shell"]];

test.each([
  [{ action: "click", x: 10, y: 20 }, [["xdotool", "mousemove", "10", "20"], ["xdotool", "click", "--repeat", "1", "1"]]],
  [{ action: "click", x: 10, y: 20, button: "right", count: 2, modifiers: ["ctrl", "shift"] },
    [["xdotool", "mousemove", "10", "20"], ["xdotool", "keydown", "ctrl+shift"], ["xdotool", "click", "--repeat", "2", "3"], ["xdotool", "keyup", "ctrl+shift"]]],
  [{ action: "mouse_down", x: 1, y: 2, button: "middle" }, [["xdotool", "mousemove", "1", "2"], ["xdotool", "mousedown", "2"]]],
  [{ action: "mouse_up", x: 1, y: 2 }, [["xdotool", "mousemove", "1", "2"], ["xdotool", "mouseup", "1"]]],
  [{ action: "move", x: 1, y: 2 }, [["xdotool", "mousemove", "1", "2"]]],
  [{ action: "drag", path: [[1, 2], [3, 4], [5, 6]] }, [["xdotool", "mousemove", "1", "2"], ["xdotool", "mousedown", "1"],
    ["xdotool", "mousemove", "3", "4"], ["xdotool", "mousemove", "5", "6"], ["xdotool", "mouseup", "1"]]],
  [{ action: "scroll", x: 5, y: 6, direction: "down", amount: 3 }, [["xdotool", "mousemove", "5", "6"], ["xdotool", "click", "--repeat", "3", "5"]]],
  [{ action: "key", combo: "ctrl+l" }, [["xdotool", "key", "--", "ctrl+l"]]],
  [{ action: "key", combo: "shift", hold: 0.1 }, [["xdotool", "keydown", "--", "shift"], ["xdotool", "keyup", "--", "shift"]]],
  [{ action: "clipboard_set", text: "hi" }, [["sh", "-c", "xclip -selection clipboard -i >/dev/null 2>&1"]]],
])("%o runs its commands, then returns a screenshot with the cursor", async (args, commands) => {
  const fake = fakeDesktop();
  const result = await run(computerTool(fake.desktop), args, fakeApi().api);
  expect(fake.calls.map((c) => c.argv)).toEqual([...commands, ...SHOT]);
  expect(result.content).toEqual([{ type: "text", text: `${args.action} — cursor at 1,2` },
    { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
  expect(fake.waits).toEqual([true]);
});

test("the screenshot is taken 500 ms after the action; screenshot: false returns only the text line", async () => {
  // a click takes ≥ 500 ms; { action: "move", x: 1, y: 2, screenshot: false } → content [{ type: "text", text: "move — cursor at 1,2" }],
  // calls: mousemove, getmouselocation --shell (no import)
});

test("type sends 50-character chunks, unparsed", async () => {
  const text = `it's "$HOME" \`x\`\n${"a".repeat(110)}`;
  await run(computerTool(fake.desktop), { action: "type", text }, fakeApi().api);
  const typed = fake.calls.filter((c) => c.argv[1] === "type");
  expect(typed.map((c) => c.argv.slice(0, 5))).toEqual(Array(3).fill(["xdotool", "type", "--delay", "12", "--"]));
  expect(typed.map((c) => c.argv[5]!.length)).toEqual([50, 50, text.length - 100]);
  expect(typed.map((c) => c.argv[5]).join("")).toBe(text);
});

test("zoom crops the region and scales it to 1280×800", async () => {
  await run(computerTool(fake.desktop), { action: "zoom", region: [10, 20, 110, 70] }, fakeApi({ desktop: false }).api);
  expect(fake.calls[0]!.argv).toEqual(["import", "-window", "root", "-crop", "100x50+10+20", "+repage", "-resize", "1280x800", "png:-"]);
});

test("read actions work outside the desktop environment; the rest are refused there", async () => {
  const { api } = fakeApi({ desktop: false });
  expect((await run(tool, { action: "screenshot" }, api)).content![1]).toMatchObject({ type: "image" });
  expect(resultText(await run(tool, { action: "cursor_position" }, api))).toBe("cursor at 1,2");
  expect(resultText(await run(tool, { action: "clipboard_get" }, api))).toBe("copied");
  fake.calls.length = 0;
  expect(resultText(await run(tool, { action: "click", x: 1, y: 2 }, api))).toBe("This acts on the desktop — start an operator job for it.");
  expect(fake.calls).toEqual([]);
  expect(fake.waits).toEqual([false, false, false]);
});

test("a failing command and a missing parameter answer as text", async () => {
  fake.reply((argv) => argv[1] === "click", { code: 1, stderr: "xdotool: bad\n" });
  expect(resultText(await run(tool, { action: "click", x: 1, y: 2 }, fakeApi().api))).toBe("click failed: xdotool: bad");
  expect(resultText(await run(tool, { action: "click", y: 2 }, fakeApi().api))).toBe("click needs x and y");
});

test("the first acting call takes the lock; reads never do", async () => {
  const { api, docs } = fakeApi();
  await run(tool, { action: "screenshot" }, api);
  expect(docs["japa.desktop-lock:1"]?.job).toBeUndefined();
  await run(tool, { action: "move", x: 1, y: 2, screenshot: false }, api);
  expect(docs["japa.desktop-lock:1"]).toEqual({ job: "1" });
});

test("another job waits, reporting progress, until the holder finishes", async () => {
  const first = fakeApi();
  await run(tool, { action: "move", x: 1, y: 2, screenshot: false }, first.api);
  const jobs = first.docs["japa.jobs:1"]!.jobs;
  jobs["2"] = { id: "2", status: "running" };
  const second = fakeApi({ conversationId: 8, job: "2", docs: first.docs });
  let done = false;
  const moving = run(tool, { action: "move", x: 3, y: 4, screenshot: false }, second.api).then(() => (done = true));
  await vi.waitFor(() => expect(jobs["2"].progress).toBe("Waiting for the desktop (in use by job 1)"));
  expect(done).toBe(false);
  jobs["1"].status = "done";
  await moving;
  expect(first.docs["japa.desktop-lock:1"]).toEqual({ job: "2" });
});

test("a job waiting on the user keeps the desktop; a finished, failed, stopped or vanished one does not", async () => {
  // holder "1" with status needs_input: job 2's claim is still pending after 300 ms; aborting its signal rejects the call.
  // holder status "failed", "cancelled", or no job "1" at all: job 2's call returns at once and the lock is { job: "2" }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/desktop-computer.test.ts`
Expected: FAIL, because `computer.ts` does not exist.

- [ ] **Step 3: Implement `lock.ts`, `computer.ts`, the SDK exports and the helpers**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/desktop src/sdk.ts test
git commit -m "feat(desktop): the computer tool and the one-operator lock"
```

---

### Task 5: The `browser` tool

**Files:**
- Create: `extensions/desktop/browser.ts`, `test/desktop-browser.test.ts`
- Modify: `package.json`, `package-lock.json` (`npm install playwright-core@^1.64.0`), `test/desktop-helpers.ts`

**Interfaces:**
- Consumes: `Desktop` (Task 3); `claimDesktop`, `OPERATOR` (Task 4); `isDesktop` (Task 2); `fakeDesktop`, `fakeApi`, `run`, `resultText` (Task 4).
- Produces (in `browser.ts`):
  - `browserTool(desktop: Desktop, connect: () => Promise<Browser>): { tool: ToolRegistration; close(): Promise<void> }`. `close` disconnects (`browser.close()`) when connected.
  - `BROWSER_READS = ["tabs", "snapshot", "text", "screenshot"]`.
  - `CUT = "[cut at 8,000 tokens]"`; `cap(text: string): string` returns text over 32,000 characters as its first 32,000, then `"\n"`, then `CUT`.
  - `stale(ref: string): string`; `unreachable(reason: string): string`.
  - `snapshotText(page: Page): Promise<string>` = `cap(\`URL: ${page.url()}\nTitle: ${await page.title()}\n${await page.ariaSnapshot({ mode: "ai" })}\`)`.
  - `byRef(page: Page, ref: string): Promise<Locator>` returns `page.getByRef(ref)`, or throws `Error(stale(ref))` when its `count()` is 0.
- The tool:
  - Name `browser`, `executionMode: "sequential"`.
  - Parameters (all optional except `action`): `action`, `tab`, `ref`, `url`, `id`, `button`, `count` (1–3), `text`, `submit`, `values`, `key`, `paths`, `gone`, `timeout` (0–30), `accept`, `js`, `fullPage`.
  - Description, verbatim: `Drive the desktop's Chromium — the same browser, tabs and logins the user sees — through its accessibility tree. Read actions work anywhere: tabs, snapshot { tab? } (elements with refs like e12), text { ref? }, screenshot { ref?, fullPage? }. Every other action needs an operator job — from the chief of staff, start one: navigate { url }, back, forward, reload, tab_new { url? }, tab_select / tab_close { id }, click / hover { ref, button?, count? }, type { ref, text, submit? } (replaces the field's content), select { ref, values }, press { key }, upload { ref, paths } (paths on the desktop), wait_for { text?, ref?, gone?, timeout? ≤ 30 s }, dialog { accept, text? }, evaluate { js }. Refs come from the latest snapshot of a tab; acting actions return the new snapshot, or the lines that changed.`
- Behaviour:
  - The flow:
    1. An acting action runs `claimDesktop` first.
    2. Then `desktop.ready(isDesktop(api.env))`.
    3. Then the connection: one `Browser` is kept and reconnected when `!isConnected()`. A connect failure answers `unreachable(<first line of its message>)`.
  - Pages come from the first context. Each page gets an id (`"1"`, `"2"`, … from a counter, assigned on first sight, including through `context.on("page")`) and a `dialog` listener that records the page's pending dialog.
  - The current tab is the one last opened or selected; when it is closed or unset, the last page. Tabs lines are `<id>: <title> — <url>`, with ` (current)` after the id of the current one.
  - Actions:
    - tabs: the tab lines.
    - snapshot: `snapshotText` of `tab` or of the current tab.
    - text: `cap(innerText)` of `byRef(…)` or of `body`.
    - screenshot: `[{ text: "URL: <url>" }, { image png }]` of the current page or of `byRef(…)`.
    - navigate: `goto`.
    - back / forward / reload: `goBack` / `goForward` / `reload`.
    - tab_new: `newPage()` (made current), then `goto` when there is a url.
    - tab_select: `bringToFront()`, made current.
    - tab_close: `close()`; the result is the tab lines.
    - click / hover: on `byRef(…)`, with `{ button, clickCount: count }`.
    - type: `fill(text)`, then `press("Enter")` when `submit`.
    - select: `selectOption(values)`.
    - press: `page.keyboard.press(key)`.
    - upload: through a CDP session — mark the element (`data-japa-upload`), then `DOM.getDocument`, `DOM.querySelector`, `DOM.setFileInputFiles({ files: paths, nodeId })`, then unmark.
    - wait_for: `(text ? page.getByText(text).first() : page.getByRef(ref)).waitFor({ state: gone ? "hidden" : "visible", timeout: (timeout ?? 10) * 1000 })`; `wait_for needs text or ref` without either.
    - dialog: `accept(text)` / `dismiss()` on the pending dialog, else `No dialog is open.`
    - evaluate: `cap(JSON.stringify(await page.evaluate(js)) ?? "undefined")`.
  - An acting action races the page's next dialog. When a dialog opens first, the result is `A <type> dialog is open: "<message>" — answer it with the dialog action.`, and the action's promise is left to finish with its errors ignored.
  - Otherwise an acting action that changes the page (everything but `tab_close`, `dialog` failures and `evaluate`) returns the page's new snapshot:
    - in full when there is no previous snapshot of that page or its URL changed;
    - else `URL: <url>\nChanged lines:\n<lines of the new snapshot not in the previous one>`, or `URL: <url>\nNo change on the page.`
    The latest snapshot per page is kept.
  - Every acting result, failures included, ends with `\nDownloaded: <paths joined by ", ">` when `desktop.exec(["find", "/home/japa/Downloads", "-maxdepth", "1", "-type", "f", "-newermt", "@<start seconds>", "!", "-name", "*.crdownload"])` lists files.
  - A throw becomes `<action> failed: <first line of its message>`, and `stale(ref)` is answered as is.
- Produces (in `test/desktop-helpers.ts`):
  - `fakePage({ url = "https://example.com/", title = "Example", snapshots = ["- heading \"Example\" [ref=e1]"], refs = {} })` is a duck-typed `Page`:
    - `url()`, `title()` and `goto(url)` (which sets the url).
    - `ariaSnapshot()` returns `snapshots` in turn, repeating the last.
    - `getByRef(ref)` returns `refs[ref]` or a locator whose `count()` is 0.
    - `on(event, listener)` records listeners, and `emit(event, value)` calls them.
    - `keyboard.press`, `bringToFront`, `isClosed() = false`, `screenshot()` returning `PNG`, `evaluate(js)`.
  - `fakeLocator({ count = 1, click? })` has `count`, `click`, `hover`, `fill`, `press`, `selectOption`, `innerText`, `screenshot`, `waitFor`.
  - `fakeBrowser(pages)` returns `{ isConnected: () => true, contexts: () => [{ pages: () => pages, on() {}, newPage }], close }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a snapshot is capped at 8,000 tokens with a note", async () => {
  const text = await snapshotText(fakePage({ snapshots: ["- x\n".repeat(20_000)] }) as unknown as Page);
  expect(text.length).toBe(32_000 + 1 + CUT.length);
  expect(text.startsWith("URL: https://example.com/\nTitle: Example\n- x")).toBe(true);
  expect(text.endsWith(`\n${CUT}`)).toBe(true);
});

test("a stale ref answers at once", async () => {
  const page = fakePage();
  const { tool } = browserTool(fakeDesktop().desktop, async () => fakeBrowser([page]) as unknown as Browser);
  const started = Date.now();
  expect(resultText(await run(tool, { action: "click", ref: "e12" }, fakeApi().api))).toBe("Element e12 is gone — take a new snapshot.");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("read actions work outside the desktop environment; acting ones are refused there", async () => {
  const { api } = fakeApi({ desktop: false });
  expect(resultText(await run(tool, { action: "tabs" }, api))).toBe("1 (current): Example — https://example.com/");
  expect(resultText(await run(tool, { action: "snapshot" }, api))).toBe('URL: https://example.com/\nTitle: Example\n- heading "Example" [ref=e1]');
  expect(resultText(await run(tool, { action: "navigate", url: "https://x.test/" }, api))).toBe(OPERATOR);
});

test("after an action on the same page, only the changed lines come back", async () => {
  // snapshots ["- a [ref=e1]\n- b", "- a [ref=e1]\n- c"], refs { e1: fakeLocator() }; snapshot, then click e1
  expect(resultText(clicked)).toBe("URL: https://example.com/\nChanged lines:\n- c");
});

test("a dialog opened by an action is reported, and answered with dialog", async () => {
  const dialog = { type: () => "confirm", message: () => "Sure?", accept: vi.fn(async () => {}), dismiss: vi.fn() };
  const page = fakePage({ refs: { e1: fakeLocator({ click: () => { page.emit("dialog", dialog); return new Promise(() => {}); } }) } });
  expect(resultText(await run(tool, { action: "click", ref: "e1" }, api))).toBe('A confirm dialog is open: "Sure?" — answer it with the dialog action.');
  await run(tool, { action: "dialog", accept: true }, api);
  expect(dialog.accept).toHaveBeenCalled();
  expect(resultText(await run(tool, { action: "dialog", accept: true }, api))).toMatch(/^No dialog is open\./);
});

test("an unreachable browser answers with the reason", async () => {
  const { tool } = browserTool(fakeDesktop().desktop, async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9222\nCall log: …"); });
  expect(resultText(await run(tool, { action: "tabs" }, fakeApi().api))).toBe("The browser is not reachable: connect ECONNREFUSED 127.0.0.1:9222");
});

test("downloads finished during an action are listed", async () => {
  fake.reply((argv) => argv[0] === "find", { stdout: Buffer.from("/home/japa/Downloads/bill.pdf\n") });
  expect(resultText(await run(tool, { action: "navigate", url: "https://example.com/bill" }, api))).toMatch(/\nDownloaded: \/home\/japa\/Downloads\/bill\.pdf$/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/desktop-browser.test.ts`
Expected: FAIL, because `browser.ts` does not exist.

- [ ] **Step 3: Add `playwright-core`; implement `browser.ts` and the fakes**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/desktop package.json package-lock.json test
git commit -m "feat(desktop): the browser tool over CDP"
```

---

### Task 6: The `desktop` extension, the image hook and the `operator` worker

**Files:**
- Create: `extensions/desktop/index.ts`, `extensions/desktop/images.ts`, `extensions/desktop/skills/using-the-desktop/SKILL.md`, `workers/operator.md`, `test/desktop.test.ts`
- Modify: `test/workers.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (in `images.ts`):
  - `OMITTED = "[earlier screenshot omitted]"`.
  - `recentImagesOnly(messages: readonly Message[], keep = 3): Message[]`. In `toolResult` messages whose `toolName` is `computer` or `browser`, every image part but the newest `keep` (counted from the end) becomes `{ type: "text", text: OMITTED }`. It returns new objects and never mutates its input.
  - `keepRecentImages = hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: recentImagesOnly(messages) }) })`.
- Produces (in `index.ts`):
  - `desktopExtension(config: DesktopConfig): JapaExtension` and `export default desktopExtension({ name: "japa-desktop", vncPort: 6080, cdpPort: 9222, docker: dockerCli })`.
  - The manifest:
    - Name `desktop`.
    - Summary `Gives me my own computer: a desktop with a browser and apps that I can see and operate`.
    - Examples `["log into my utility portal and download the latest bill", "what's on the desktop right now?"]`.
    - Docs `./skills/using-the-desktop/SKILL.md`.
    - `provides: { environment: [{ name: "desktop", create: ({ cwd }) => remoteEnv(envServer, cwd ?? "/home/japa", \`docker:${config.name}\`) }], tool: [computerTool(desktop), browser.tool] }`.
    - `durable: { hooks: [keepRecentImages] }`, `secrets: ["desktop.vncPassword"]`.
    - `settings: Type.Object({ cpus: Type.Optional(Type.Number()), memory: Type.Optional(Type.String()), shm: Type.Optional(Type.String()), bind: Type.Optional(Type.String()) })`.
    - `status: () => (kernel ? desktop.status() : undefined)`.
    - `setup` keeps the `KernelContext` and returns a dispose that runs `desktop.dispose()`, closes the env server and awaits `browser.close()`. It touches no Docker.
  - `connect = () => chromium.connectOverCDP(\`http://127.0.0.1:${config.cdpPort}\`, { noDefaults: true, timeout: 10_000 })`.
  - `envServer(): Promise<EnvServer>` returns the live server, or starts one, with concurrent first calls sharing the start:
    1. `await desktop.ready(true)`;
    2. `config.docker(["cp", dirname(ENV_MODULE), \`${config.name}:/opt/japa/\`])` and `config.docker(["cp", SERVER, \`${config.name}:/opt/japa/env-server.ts\`])`; a code ≠ 0 throws its stderr;
    3. `startEnvServer(["docker", "exec", "-i", "-u", "japa", config.name, "node", "/opt/japa/env-server.ts", "/opt/japa/env/node.js"])`.
- `workers/operator.md`:
  - The frontmatter is exactly spec §2.3's: `name: operator`, the description, `tools: [read, write, edit, bash]`, `environment: desktop`, `extensions: [desktop]`.
  - The body says the six rules of spec §2.3 as plain instructions (browser first; look before acting and verify after, zoom for small text; end the turn asking the user for MFA, CAPTCHAs and payments; `~/shared` and `~/attachments`; apt installs are lost on upgrades; finish with what was done, where results are, what is left). Then: report progress with `job_progress` and finish with `job_complete`. No backticked snake_case action names.
- `skills/using-the-desktop/SKILL.md` (frontmatter `name: using-the-desktop` and a description) covers spec §5:
  - glance yourself (screenshot, browser snapshot); start an `operator` job for anything that acts, with a brief naming the site or app, the goal and what to bring back;
  - how the user takes over: `ssh -L 6080:localhost:6080 <server>`, then `http://localhost:6080/vnc.html`, or `extensions.desktop.bind` set to a Tailscale address; the password is the secret `desktop.vncPassword`, in `~/.japa/secrets/desktop.vncPassword` with the default store;
  - files: `~/shared` ↔ `~/.japa/desktop/shared`, and `~/attachments` read-only;
  - "the desktop needs Docker" means Docker must be installed and usable by the user running japa.

- [ ] **Step 1: Write the failing tests**

```ts
// test/desktop.test.ts
test("only the 3 newest screenshots stay in the model's context", () => {
  const shot = (toolName: string) => ({ role: "toolResult", toolCallId: toolName, toolName, isError: false, timestamp: 0,
    content: [{ type: "text", text: "t" }, { type: "image", data: toolName, mimeType: "image/png" }] }) as Message;
  const user = { role: "user", timestamp: 0, content: [{ type: "image", data: "u", mimeType: "image/png" }] } as Message;
  const messages = [shot("computer"), user, shot("browser"), shot("computer"), shot("other"), shot("browser"), shot("computer")];
  const kept = recentImagesOnly(messages);
  const images = (m: Message) => (typeof m.content === "string" ? [] : m.content.filter((c) => c.type === "image"));
  expect(kept.map((m) => images(m).length)).toEqual([0, 1, 0, 1, 1, 1, 1]);
  expect(JSON.stringify(kept[0])).toContain(OMITTED);
  expect(images(messages[0]!)).toHaveLength(1); // input unchanged
});

test("the chief of staff's glances: the model sees 3 screenshots, storage keeps all 5", async () => {
  const fake = fakeDocker();
  const { daemon, faux } = await bootTest({}, [desktopExtension(testConfig(fake.docker))]);
  let seen: Message[] = [];
  const step: FauxResponseFactory = ({ messages }) => {
    if (messages.filter((m) => m.role === "toolResult").length < 5) return call("computer", { action: "screenshot" });
    seen = [...messages];
    return say("done");
  };
  faux.setResponses(Array.from({ length: 6 }, () => step));
  await ask(daemon, "look");
  const images = (ms: Message[]) => ms.flatMap((m) => (m.role === "toolResult" ? m.content : [])).filter((c) => c.type === "image");
  expect(images(seen)).toHaveLength(3);
  expect(JSON.stringify(seen).split(OMITTED)).toHaveLength(3);
  const stored = (await daemon.root.entries({}, 200, undefined, ctx)).items.flatMap((e) => e.model ?? []);
  expect(images(stored)).toHaveLength(5);
  await daemon.close();
});

test("a default install loads the desktop without touching Docker", async () => {
  const { daemon } = await bootTest();
  expect(daemon.status().errors).toEqual([]);
  expect(daemon.status().extensions).toContainEqual({ name: "desktop",
    summary: "Gives me my own computer: a desktop with a browser and apps that I can see and operate",
    provides: ["environment", "tool"], status: "noVNC: http://127.0.0.1:6080/vnc.html (password: secret desktop.vncPassword)" });
  expect(daemon.capabilities()).toContain("- operator: Operates japa's own desktop computer — browser and apps — to get things done on websites and in programs.");
  await daemon.close();
});

test("an operator job acts in the container and holds the desktop", async () => {
  const fake = fakeDocker();
  const { daemon, faux } = await bootTest({}, [desktopExtension(testConfig(fake.docker))]);
  script(faux, (role, text) =>
    text === "go" ? call("job_start", { title: "Click", brief: "click it", worker: "operator" })
    : text === "click it" ? fauxAssistantMessage([fauxToolCall("computer", { action: "click", x: 1, y: 2 })], { stopReason: "toolUse" })
    : role === "toolResult" && text.startsWith("click — cursor") ? call("job_complete", { summary: "clicked" })
    : undefined);
  await ask(daemon, "go");
  await waitFor(async () => (await reported(daemon)).length > 0, 10_000);
  expect(fake.calls).toContainEqual(["exec", "-u", "japa", "japa-desktop", "xdotool", "mousemove", "1", "2"]);
  expect(await daemon.harness.snapshot(LockDoc, ROOT_CONVERSATION_ID, ctx)).toEqual({ job: "1" });
  await daemon.close();
});
```

In `test/workers.test.ts`, `the shipped coder and researcher profiles pass at boot` also expects the operator line in `capabilities()`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest --run test/desktop.test.ts test/workers.test.ts`
Expected: FAIL, because `index.ts` and `images.ts` don't exist.

- [ ] **Step 3: Implement `images.ts`, `index.ts`, the skill and the operator profile**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS, including `test/content.test.ts`: the operator profile passes `japa check`, and every tool name it mentions exists.

- [ ] **Step 5: Commit**

```bash
git add extensions/desktop workers/operator.md test
git commit -m "feat(desktop): the desktop extension, screenshot pruning and the operator worker"
```

---

### Task 7: On Docker, and the docs

**Files:**
- Modify: `test/desktop-docker.test.ts`, `README.md`, `docs/superpowers/specs/2026-10-07-japa-design.md`

**Interfaces:**
- Consumes: `desktopExtension` (Task 6), the Task 3 suite's `config`, `stub` and `beforeAll`, and `fakeApi`, `run`, `resultText` (Task 4).

Inside Task 3's `describe`, add a nested `describe("through the extension")`:
- `ext = desktopExtension(config)`;
- `beforeAll`: `ext.setup!(stub.kernel)`, and write `<stub.home>/desktop/shared/page.html` = `<h1>Hello japa</h1><input autofocus><button style="position:fixed;left:0;right:0;top:40%;bottom:0" onclick="document.body.dataset.clicked='yes'">Go</button>`;
- `afterAll`: its dispose;
- `[computer, browser]` from `ext.provides.tool`; `api = fakeApi().api` (desktop environment); `PAGE = "file:///home/japa/shared/page.html"`.

- [ ] **Step 1: Write the Docker tests**

```ts
registerEnvConformance({ describe, expect, it }, "desktop environment in the container", async (use) => {
  const dir = `/tmp/conformance-${randomUUID()}`;
  await dockerCli(["exec", "-u", "japa", config.name, "mkdir", dir]);
  try {
    await use((ext.provides!.environment![0] as EnvironmentAdapter).create({ conversationId: "c", cwd: dir }));
  } finally {
    await dockerCli(["exec", "-u", "japa", config.name, "rm", "-rf", dir]);
  }
});

test("computer click and type change a test page", async () => {
  await run(browser, { action: "navigate", url: PAGE }, api);
  await run(computer, { action: "type", text: "hello", screenshot: false }, api);
  expect(resultText(await run(browser, { action: "evaluate", js: "document.querySelector('input').value" }, api))).toContain('"hello"');
  await run(computer, { action: "click", x: 640, y: 650 }, api);
  expect(resultText(await run(browser, { action: "evaluate", js: "document.body.dataset.clicked" }, api))).toContain('"yes"');
}, 120_000);

test("browser navigate returns refs, and click by ref works", async () => {
  const page = resultText(await run(browser, { action: "navigate", url: PAGE }, api));
  const ref = page.match(/button "Go" \[ref=(e\d+)\]/)![1]!;
  await run(browser, { action: "click", ref }, api);
  expect(resultText(await run(browser, { action: "evaluate", js: "document.body.dataset.clicked" }, api))).toContain('"yes"');
}, 120_000);

test("a cookie set in the browser survives a container restart and a recreate", async () => {
  // docker exec -d -u japa <name> python3 -m http.server 8000 --directory /home/japa/shared; navigate http://localhost:8000/page.html;
  // evaluate document.cookie = "k=v; max-age=86400"
  // `docker restart <name>`; vi.waitFor (60 s) until navigate works again; evaluate document.cookie contains "k=v"
  // `docker stop` + `docker rm` <name>; a computer screenshot recreates it on the same volume; restart http.server; navigate; cookie contains "k=v"
}, 300_000);

test("an operator job, with scripted model calls, opens a page and reports its heading", async () => {
  // bootTest({}, [desktopExtension(config)]); write page.html into that home's desktop/shared (a new home recreates the container);
  // script: "go" → job_start { worker: "operator", brief: "open the page" }; "open the page" → browser navigate { url: PAGE };
  // a browser toolResult with /heading "([^"]+)"/ → job_complete { summary: `The heading is ${m[1]}` }
  await waitFor(async () => (await reported(daemon)).some((r) => r.includes("The heading is Hello japa")), 120_000);
}, 300_000);
```

- [ ] **Step 2: Run them on Docker**

Run: `JAPA_DOCKER_TESTS=1 npx vitest --run test/desktop-docker.test.ts`
Expected: PASS. Fix the extension, image or wiring where they fail.

- [ ] **Step 3: Write the docs**

- README:
  - a "Desktop" section: Docker is required, installed and usable by the user running japa; the first use builds the image (a few minutes); reach noVNC with `ssh -L 6080:localhost:6080 <server>` then `http://localhost:6080/vnc.html`, or set `extensions.desktop.bind` to a Tailscale address; the password is in `~/.japa/secrets/desktop.vncPassword`; files are exchanged in `~/.japa/desktop/shared`; the settings `cpus`, `memory`, `shm` and `bind`, where a change recreates the container on the next use and keeps its home;
  - "Where state lives" gains `desktop/shared/  files shared with japa's desktop (ignored by git)`;
  - "Development" gains `JAPA_DOCKER_TESTS=1 npx vitest --run test/desktop-docker.test.ts`.
- Main spec:
  - §4.1 `KernelContext` gains `setSecret(name, value)`;
  - §5.1's manifest gains `status: () => string | undefined  // a line under the extension in japa status`;
  - §11.1 adds the `desktop` row (`environment, tool, durable`: a persistent Docker desktop; the `desktop` environment, `computer` and `browser`; a pointer to the computer-use spec);
  - §11.2 adds the `operator` profile;
  - §13 adds `extensions/desktop/  environment + tools + Docker image`.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS, with the Docker suite skipped.

- [ ] **Step 5: Commit**

```bash
git add test README.md docs/superpowers/specs/2026-10-07-japa-design.md
git commit -m "test(desktop): end to end on Docker; docs"
```
