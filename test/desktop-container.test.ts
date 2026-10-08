import type { JsonObject } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  BUILDING,
  DESKTOP_DIR,
  desktopContainer,
  dockerCli,
  IMAGE_HASH,
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

test("an operator's call waits for the build, then the container is created and started", async () => {
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
  expect(desktop.status()).toBe("The desktop needs Docker: the docker command was not found");

  const denied = setup();
  denied.fake.reply((a) => a[0] === "container", {
    code: 1,
    stderr: "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n",
  });
  await expect(denied.desktop.ready(false)).rejects.toThrow(
    "The desktop needs Docker: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
  );
});

test("a failed build is reported once, then built again", async () => {
  const { fake, desktop } = setup();
  fake.state.image = false;
  fake.reply((a) => a[0] === "build", { code: 1, stderr: "#5 ERROR\nE: Unable to locate package nope\n" });
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  await vi.waitFor(() =>
    expect(desktop.status()).toBe("The desktop image failed to build: E: Unable to locate package nope"));
  await expect(desktop.ready(false)).rejects.toThrow("The desktop image failed to build: E: Unable to locate package nope");
  await expect(desktop.ready(false)).rejects.toThrow(STARTING);
  expect(fake.calls.filter((c) => c[0] === "build")).toHaveLength(2);
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

test("dockerCli reports a missing docker command", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    await expect(dockerCli(["version"])).rejects.toThrow("the docker command was not found");
  } finally {
    process.env.PATH = path;
  }
});
