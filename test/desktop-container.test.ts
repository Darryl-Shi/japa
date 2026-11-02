import type { JsonObject } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  BROWSER_RESTARTED,
  BUILDING,
  DESKTOP_DIR,
  DESKTOP_RESTARTED,
  desktopContainer,
  dockerCli,
  IMAGE_HASH,
  PARTS,
  PROBE,
  RECREATED,
  STARTING,
  UPGRADED,
} from "../extensions/desktop/container.ts";
import { fakeDocker, stubKernel, testConfig } from "./desktop-helpers.ts";

function setup(settings: JsonObject = {}) {
  const fake = fakeDocker();
  const stub = stubKernel(settings);
  return { fake, stub, desktop: desktopContainer(testConfig(fake.docker), () => stub.kernel) };
}

test("the first call builds the image in the background and answers that the desktop is starting", async () => {
  const { fake, desktop } = setup();
  fake.state.image = false;
  const release = fake.holdBuild();
  const results = await Promise.allSettled([desktop.ready(false), desktop.ready(false)]);
  expect(results.map((r) => r.status === "rejected" && (r.reason as Error).message)).toEqual([STARTING, STARTING]);
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  expect(fake.calls.filter((c) => c[0] === "build")).toEqual([
    ["build", "-t", `japa-desktop:${IMAGE_HASH}`, "--label", `japa.desktop.hash=${IMAGE_HASH}`, DESKTOP_DIR],
  ]);
  expect(desktop.status()).toBe(BUILDING);
  release();
});

test("a job's call waits for the build, then the container is created and started", async () => {
  const { fake, desktop } = setup();
  fake.state.image = false;
  const release = fake.holdBuild();
  let done = false;
  const ready = desktop.ready(true).then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(done).toBe(false);
  expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
  release();
  await ready;
  expect(fake.state.container).toMatchObject({ running: true });
});

test("the container gets the limits, ports, mounts and a generated VNC password", async () => {
  const { fake, stub, desktop } = setup({ cpus: 4, memory: "8g", shm: "1g", bind: "100.64.0.1" });
  await desktop.ready(false);
  const password = stub.secrets["desktop.vncPassword"]!;
  expect(password).toMatch(/^[A-Za-z0-9]{16}$/);
  expect(fake.calls.find((c) => c[0] === "run")).toEqual([
    "run", "-d", "--label", expect.stringMatching(/^japa\.desktop\.hash=[0-9a-f]{12}$/),
    "--name", "japa-desktop", "--restart", "unless-stopped", "--network", "japa-desktop-net", "--cpus", "4", "--memory", "8g", "--shm-size", "1g",
    "-p", "100.64.0.1:6080:6080", "-p", "127.0.0.1:9222:9223", "-v", "japa-desktop-home:/home/japa",
    "-v", `${stub.home}/desktop/shared:/home/japa/shared`, "-v", `${stub.home}/attachments:/home/japa/attachments:ro`,
    "-e", `VNC_PASSWORD=${password}`, `japa-desktop:${IMAGE_HASH}`,
  ]);
  const commands = fake.calls.map((c) => c[0]);
  expect(fake.calls[commands.indexOf("run") - 1]).toEqual(["network", "create", "japa-desktop-net"]);
  expect(existsSync(join(stub.home, "desktop/shared"))).toBe(true);
  expect(desktop.status()).toBe("noVNC: http://100.64.0.1:6080/vnc.html (password: secret desktop.vncPassword)");

  const defaults = setup();
  await defaults.desktop.ready(false);
  expect(defaults.fake.calls.find((c) => c[0] === "run")).toEqual(expect.arrayContaining([
    "--cpus", "2", "--memory", "4g", "--shm-size", "2g", "-p", "127.0.0.1:6080:6080",
  ]));
  expect(defaults.desktop.status()).toBe("noVNC: http://127.0.0.1:6080/vnc.html (password: secret desktop.vncPassword)");
});

test("a current container is used as is; a stopped one is started and checked", async () => {
  const { fake, desktop } = setup();
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
  const { fake, stub, desktop } = setup();
  await desktop.ready(false);
  stub.settings.bind = "100.64.0.1";
  fake.calls.length = 0;
  await desktop.ready(false);
  expect(fake.calls.map((c) => c[0])).toEqual(["container", "image", "stop", "rm", "network", "run", "exec", "exec"]);
  expect(fake.calls.find((c) => c[0] === "run")).toContain("japa-desktop-home:/home/japa");
  expect(stub.emitted).toEqual([{ key: `upgrade:${fake.state.container!.hash}`, text: UPGRADED }]);
  fake.state.container!.hash = "0123456789ab"; // made from older image files
  await desktop.ready(false);
  expect(stub.emitted).toHaveLength(2);
});

test("without Docker every call says so, and so does the status line", async () => {
  const { fake, desktop } = setup();
  fake.reply(() => true, new Error("the docker command was not found"));
  await expect(desktop.ready(false)).rejects.toThrow("The desktop needs Docker: the docker command was not found");
  expect(desktop.status()).toBe(
    "The desktop needs Docker: the docker command was not found (install it: https://docs.docker.com/engine/install/)",
  );

  const denied = setup();
  denied.fake.reply((a) => a[0] === "container", {
    code: 1,
    stderr: "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n",
  });
  await expect(denied.desktop.ready(false)).rejects.toThrow(
    "The desktop needs Docker: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
  );
  expect(denied.desktop.status()).toMatch(/sudo usermod -aG docker \$USER, then restart japa from a new login\)$/);
});

test("a failed build is retried once on a pruned build cache, then reported once, then built again", async () => {
  const { fake, desktop } = setup();
  fake.state.image = false;
  fake.reply((a) => a[0] === "build", { code: 1, stderr: "#5 ERROR\nE: Unable to locate package nope\n" });
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  await vi.waitFor(() =>
    expect(desktop.status()).toBe("The desktop image failed to build: E: Unable to locate package nope"));
  expect(fake.calls.filter((c) => c[0] === "build" || c[0] === "builder").map((c) => c.slice(0, 3))).toEqual([
    ["build", "-t", `japa-desktop:${IMAGE_HASH}`], ["builder", "prune", "-af"], ["build", "-t", `japa-desktop:${IMAGE_HASH}`],
  ]);
  await expect(desktop.ready(false)).rejects.toThrow("The desktop image failed to build: E: Unable to locate package nope");
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  await vi.waitFor(() => expect(fake.calls.filter((c) => c[0] === "build")).toHaveLength(4));
});

test("a build that fails on a stale build cache succeeds after pruning it", async () => {
  const { fake, desktop } = setup();
  fake.state.image = false;
  fake.replyTimes(1, (a) => a[0] === "build", {
    code: 1,
    stderr: "ERROR: failed to extract layer: failed to get reader from content store: content digest sha256:ab not found\n",
  });
  await desktop.ready(true);
  expect(fake.calls.filter((c) => c[0] === "build" || c[0] === "builder").map((c) => c[0])).toEqual(["build", "builder", "build"]);
  expect(fake.state.container).toMatchObject({ running: true });
  expect(desktop.status()).toMatch(/^noVNC: /);
});

/** No call touches the desktop's home volume, other than mounting it in `run`. */
const keptHome = (calls: string[][]) =>
  expect(calls.filter((c) => c[0] === "volume" || (c[0] !== "run" && c.join(" ").includes("japa-desktop-home")))).toEqual([]);
const LAYER_GONE = { code: 1, stderr: "Error response from daemon: RWLayer of container 4f2 is unexpectedly nil\n" };

test("a current container that won't start is removed and recreated on the same volume, and the chief of staff is told", async () => {
  const { fake, stub, desktop } = setup();
  await desktop.ready(false);
  fake.state.container!.running = false;
  fake.replyTimes(1, (a) => a[0] === "start", LAYER_GONE);
  fake.calls.length = 0;
  await desktop.ready(false);
  expect(fake.calls.map((c) => c[0])).toEqual(["container", "start", "rm", "image", "network", "run", "exec", "exec"]);
  expect(fake.calls[2]).toEqual(["rm", "-f", "japa-desktop"]);
  expect(fake.calls.find((c) => c[0] === "run")).toContain("japa-desktop-home:/home/japa");
  expect(stub.emitted).toEqual([{ key: expect.stringMatching(/^recreate:/), text: RECREATED }]);
  expect(desktop.status()).toMatch(/^noVNC: /);
  keptHome(fake.calls);

  // Recovered, so a later breakage is recovered from again.
  fake.state.container!.running = false;
  fake.replyTimes(1, (a) => a[0] === "start", LAYER_GONE);
  await desktop.ready(false);
  expect(fake.calls.filter((c) => c[0] === "rm")).toHaveLength(2);
  expect(stub.emitted).toHaveLength(2);
  expect(stub.emitted[0]!.key).not.toBe(stub.emitted[1]!.key);
});

test("a container that won't start, whose image is gone too, is removed and recreated from a rebuilt image", async () => {
  const { fake, desktop } = setup();
  await desktop.ready(false);
  fake.state.container!.running = false;
  fake.state.image = false;
  fake.replyTimes(1, (a) => a[0] === "start", LAYER_GONE);
  fake.calls.length = 0;
  await desktop.ready(true);
  expect(fake.calls.map((c) => c[0])).toEqual([
    "container", "start", "rm", "image", "build", "container", "image", "network", "run", "exec", "exec",
  ]);
  expect(fake.state.container).toMatchObject({ running: true });
  keptHome(fake.calls);
});

test("a new container that won't run has its image removed and rebuilt once", async () => {
  const { fake, stub, desktop } = setup();
  fake.replyTimes(1, (a) => a[0] === "run", {
    code: 1,
    stderr: "docker: Error response from daemon: failed to get reader from content store: content digest sha256:ab not found\n",
  });
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  await desktop.ready(true);
  expect(fake.calls.map((c) => c.slice(0, 2))).toEqual([
    ["container", "inspect"], ["image", "inspect"], ["network", "create"], ["run", "-d"],
    ["rm", "-f"], ["image", "rm"], ["build", "-t"],
    ["container", "inspect"], ["image", "inspect"], ["network", "create"], ["run", "-d"], ["exec", "-u"], ["exec", "-u"],
  ]);
  expect(fake.calls.find((c) => c[0] === "image" && c[1] === "rm")).toEqual(["image", "rm", "-f", `japa-desktop:${IMAGE_HASH}`]);
  expect(fake.state.container).toMatchObject({ running: true });
  expect(stub.emitted).toEqual([]); // nothing was lost: there was no container before
  keptHome(fake.calls);
});

test("a desktop still failing after its recovery reports the error as before, without rebuilding again", async () => {
  const { fake, desktop } = setup();
  await desktop.ready(false);
  fake.state.container!.running = false;
  fake.reply((a) => a[0] === "start", LAYER_GONE);
  fake.reply((a) => a[0] === "run", { code: 125, stderr: "docker: Error response from daemon: port is already allocated\n" });
  await expect(desktop.ready(true)).rejects.toThrow(
    "The desktop could not start: docker: Error response from daemon: port is already allocated",
  );
  expect(desktop.status()).toBe("The desktop could not start: docker: Error response from daemon: port is already allocated");
  await expect(desktop.ready(true)).rejects.toThrow("The desktop could not start: docker: Error response from daemon: port is already allocated");
  expect(fake.calls.filter((c) => c[0] === "build")).toHaveLength(1);
  expect(fake.calls.filter((c) => c[0] === "image" && c[1] === "rm")).toHaveLength(1);
  keptHome(fake.calls);
});

test("a build that can't run is reported, not thrown", async () => {
  const { fake, desktop } = setup();
  fake.state.image = false;
  fake.reply((a) => a[0] === "build", new Error("the docker command was not found"));
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  await vi.waitFor(() => expect(desktop.status()).not.toBe(BUILDING));
  await expect(desktop.ready(false)).rejects.toThrow("The desktop needs Docker: the docker command was not found");
});

test("exec runs as japa inside the container", async () => {
  const { fake, desktop } = setup();
  await desktop.exec(["xdotool", "getmouselocation"]);
  await desktop.exec(["xclip", "-i"], "hi");
  expect(fake.calls.slice(-2)).toEqual([
    ["exec", "-u", "japa", "japa-desktop", "xdotool", "getmouselocation"],
    ["exec", "-i", "-u", "japa", "japa-desktop", "xclip", "-i"],
  ]);
  expect(fake.inputs.at(-1)).toBe("hi");
});

/** Matches the watchdog's `curl` of `path` on the browser's DevTools endpoint. */
const cdp = (path: string) => (args: string[]) => args[0] === "exec" && args.at(-1) === `http://127.0.0.1:9222${path}`;
const PKILL = ["exec", "-u", "japa", "japa-desktop", "pkill", "-KILL", "-f", "^/usr/lib/chromium/"];
const supervisorctl = (part: string) => ["exec", "-u", "root", "japa-desktop", "supervisorctl", "restart", part];
/** The watchdog's actions: restarts of parts, the browser or the container, and starts. */
const actions = (calls: string[][]) =>
  calls.filter((c) => c.includes("pkill") || c.includes("supervisorctl") || c[0] === "restart" || c[0] === "start");
/** Runs `times` watchdog checks. */
const watch = async (desktop: { watch(): Promise<void> }, times: number) => {
  for (let i = 0; i < times; i++) await desktop.watch();
};
/** Runs `body` with console.error silenced; answers what was logged. */
async function quietly(body: () => Promise<void>) {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await body();
    return logged.mock.calls.map((c) => c[0]);
  } finally {
    logged.mockRestore();
  }
}

test("the watchdog checks every part of the desktop in one call, only while the desktop is up", async () => {
  const { fake, desktop } = setup();
  await desktop.watch();
  expect(fake.calls).toEqual([]); // not up: nothing to check
  await desktop.ready(false);
  fake.calls.length = 0;
  await desktop.watch();
  expect(fake.calls[0]).toEqual(["exec", "-u", "japa", "japa-desktop", "sh", "-c", PROBE]);
  for (const check of Object.values(PARTS)) expect(PROBE).toContain(`(${check}) >/dev/null 2>&1 || echo `);
  expect(PROBE.split("\n").slice(-2)).toEqual(["wait", "echo probed"]);
  expect(actions(fake.calls)).toEqual([]);
});

test("a part that fails three checks in a row is restarted, and if that doesn't mend it, the whole desktop", async () => {
  const { fake, stub, desktop } = setup();
  await desktop.ready(false);
  const logged = await quietly(async () => {
    fake.state.failing = ["x11vnc"];
    await watch(desktop, 2);
    expect(actions(fake.calls)).toEqual([]);
    await desktop.watch();
    expect(actions(fake.calls)).toEqual([supervisorctl("x11vnc")]);
    expect(stub.emitted).toEqual([]); // nothing the chief of staff uses was lost
    await watch(desktop, 3);
    expect(actions(fake.calls)).toEqual([supervisorctl("x11vnc"), ["restart", "-t", "10", "japa-desktop"]]);
    expect(stub.emitted).toEqual([{ key: expect.stringMatching(/^desktop-restart:/), text: DESKTOP_RESTARTED }]);
  });
  expect(logged).toEqual(["desktop: x11vnc stopped answering; restarted it", "desktop: the container stopped answering; restarted it"]);
});

test("a part that answers again after its restart is restarted alone the next time", async () => {
  const { fake, desktop } = setup();
  await desktop.ready(false);
  await quietly(async () => {
    fake.state.failing = ["novnc"];
    await watch(desktop, 3);
    fake.state.failing = [];
    await desktop.watch();
    fake.state.failing = ["novnc"];
    await watch(desktop, 3);
  });
  expect(actions(fake.calls)).toEqual([supervisorctl("novnc"), supervisorctl("novnc")]);
});

test("a frozen browser is killed (supervisord starts it again) and the chief of staff told; its DevTools forward isn't blamed", async () => {
  const { fake, stub, desktop } = setup();
  await desktop.ready(false);
  const logged = await quietly(async () => {
    fake.state.failing = ["chromium", "cdp"];
    await watch(desktop, 3);
  });
  expect(actions(fake.calls)).toEqual([PKILL]);
  expect(stub.emitted).toEqual([{ key: expect.stringMatching(/^browser-restart:/), text: BROWSER_RESTARTED }]);
  expect(logged).toEqual(["desktop: the browser stopped answering; restarted it"]);
});

test("a dead screen restarts the whole desktop at once, not the parts that need it", async () => {
  const { fake, stub, desktop } = setup();
  await desktop.ready(false);
  await quietly(async () => {
    fake.state.failing = ["xvfb", "xfce", "x11vnc", "chromium", "cdp"];
    await watch(desktop, 3);
  });
  expect(actions(fake.calls)).toEqual([["restart", "-t", "10", "japa-desktop"]]);
  expect(stub.emitted.map((e) => e.text)).toEqual([DESKTOP_RESTARTED]);
});

test("a desktop too stuck to run the probe is restarted; a stopped one is started again", async () => {
  const { fake, stub, desktop } = setup();
  await desktop.ready(false);
  await quietly(async () => {
    fake.replyTimes(3, (a) => a.at(-1) === PROBE, { code: 137 }); // killed by the watchdog's timeout
    await watch(desktop, 3);
    expect(actions(fake.calls)).toEqual([["restart", "-t", "10", "japa-desktop"]]);
    expect(stub.emitted.map((e) => e.text)).toEqual([DESKTOP_RESTARTED]);
    await desktop.watch(); // all well again

    fake.state.container!.running = false;
    fake.calls.length = 0;
    await watch(desktop, 3);
  });
  expect(actions(fake.calls)).toEqual([["start", "japa-desktop"]]);
  expect(fake.state.container!.running).toBe(true);
  expect(stub.emitted).toHaveLength(1); // starting it again isn't news
});

test("a desktop that stays broken is restarted less and less often, and the chief of staff told once", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { fake, stub, desktop } = setup();
    await desktop.ready(false);
    const minutes: number[] = []; // when the container was restarted
    const run = (from: number, to: number) =>
      quietly(async () => {
        for (let minute = from; minute <= to; minute++) {
          vi.setSystemTime(minute * 60_000);
          const before = actions(fake.calls).length;
          await desktop.watch();
          if (actions(fake.calls).length > before) minutes.push(minute);
        }
      });
    fake.state.failing = ["xvfb"];
    await run(1, 40);
    expect(minutes).toEqual([3, 6, 12, 21, 39]); // waits of 2, 4, 8, 16 min (and the 3 checks it takes to notice)
    expect(stub.emitted.map((e) => e.text)).toEqual([DESKTOP_RESTARTED]);

    fake.state.failing = []; // mended: the next outage starts afresh
    await run(41, 41);
    fake.state.failing = ["xvfb"];
    await run(42, 44);
    expect(minutes.at(-1)).toBe(44);
    expect(stub.emitted).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("an answer resets the watchdog's count, and nothing is said when there was no browser to kill", async () => {
  const { fake, stub, desktop } = setup();
  await desktop.ready(false);
  fake.state.failing = ["chromium"];
  await watch(desktop, 2);
  fake.state.failing = [];
  await watch(desktop, 3);
  fake.state.failing = ["chromium"];
  await watch(desktop, 2);
  expect(actions(fake.calls)).toEqual([]);
  fake.reply((a) => a.includes("pkill"), { code: 1 });
  await desktop.watch();
  expect(actions(fake.calls)).toEqual([PKILL]);
  expect(stub.emitted).toEqual([]);
});

test("with memory high, the watchdog closes the tabs beyond the five most recently active", async () => {
  const { fake, desktop } = setup();
  await desktop.ready(false);
  // DevTools lists the most recently active first; workers and other targets aren't tabs.
  const targets = [
    { id: "P1", type: "page" }, { id: "W1", type: "service_worker" }, { id: "P2", type: "page" }, { id: "P3", type: "page" },
    { id: "P4", type: "page" }, { id: "I1", type: "iframe" }, { id: "P5", type: "page" }, { id: "P6", type: "page" },
    { id: "../bad", type: "page" }, { id: "P7", type: "page" },
  ];
  fake.reply(cdp("/json/list"), { stdout: Buffer.from(JSON.stringify(targets)) });
  fake.reply((a) => a[0] === "stats", { stdout: Buffer.from("74.9%\n") });
  const logged = await quietly(async () => {
    await desktop.watch();
    expect(fake.calls.find((c) => c[0] === "stats")).toEqual(["stats", "--no-stream", "--format", "{{.MemPerc}}", "japa-desktop"]);
    expect(fake.calls.some(cdp("/json/list"))).toBe(false);
    fake.reply((a) => a[0] === "stats", { stdout: Buffer.from("75.02%\n") });
    await desktop.watch();
  });
  expect(fake.calls.filter((c) => c.at(-1)!.includes("/json/close/")).map((c) => c.at(-1))).toEqual([
    "http://127.0.0.1:9222/json/close/P6", "http://127.0.0.1:9222/json/close/P7",
  ]);
  expect(logged).toEqual(["desktop: memory at 75% of its limit; closed 2 idle browser tabs"]);

  // Not while the browser is failing.
  fake.state.failing = ["chromium"];
  fake.calls.length = 0;
  await desktop.watch();
  expect(fake.calls.some((c) => c[0] === "stats")).toBe(false);
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
