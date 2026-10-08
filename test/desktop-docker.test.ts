import type { ToolRegistration } from "@earendil-works/pi-durable";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, test, vi } from "vitest";
import { desktopContainer, dockerCli } from "../extensions/desktop/container.ts";
import { desktopExtension } from "../extensions/desktop/index.ts";
import type { Dispose, EnvironmentAdapter } from "../src/kernel/contracts.ts";
import { fakeApi, resultText, run, stubKernel } from "./desktop-helpers.ts";
import { bootTest, waitFor } from "./helpers.ts";
import { ask, call, reported, script } from "./jobs-helpers.ts";

const config = { name: "japa-desktop-test", vncPort: 16080, cdpPort: 19222, docker: dockerCli };
const PAGE_HTML =
  `<h1>Hello japa</h1><input autofocus><button style="position:fixed;left:0;right:0;top:40%;bottom:0" ` +
  `onclick="document.body.dataset.clicked='yes'">Go</button>`;
const PAGE = "file:///home/japa/shared/page.html";

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

  describe("through the extension", () => {
    const ext = desktopExtension(config);
    let dispose: Dispose | void;
    beforeAll(async () => {
      dispose = await ext.setup!(stub.kernel);
      writeFileSync(join(stub.home, "desktop/shared/page.html"), PAGE_HTML);
    });
    afterAll(() => dispose?.());
    const [computer, browser] = ext.provides!.tool! as ToolRegistration[];
    const api = fakeApi().api;
    /** Serves the shared directory on the container's port 8000. */
    const serve = () =>
      dockerCli(["exec", "-d", "-u", "japa", config.name, "python3", "-m", "http.server", "8000", "--directory", "/home/japa/shared"]);
    /** Navigates to the served page until it loads (the server and the browser may still be starting); returns document.cookie. */
    const cookie = async () => {
      await vi.waitFor(
        async () => expect(resultText(await run(browser, { action: "navigate", url: "http://localhost:8000/page.html" }, api))).toContain("Hello japa"),
        { timeout: 60_000, interval: 1000 },
      );
      return resultText(await run(browser, { action: "evaluate", js: "document.cookie" }, api));
    };

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
      const page = resultText(await run(browser, { action: "navigate", url: `${PAGE}?refs` }, api));
      const ref = page.match(/button "Go" \[ref=(\w+)\]/)![1]!;
      await run(browser, { action: "click", ref }, api);
      expect(resultText(await run(browser, { action: "evaluate", js: "document.body.dataset.clicked" }, api))).toContain('"yes"');
    }, 120_000);

    test("a cookie set in the browser survives a container restart and a recreate", async () => {
      await serve();
      expect(await cookie()).not.toContain("k=v");
      await run(browser, { action: "evaluate", js: 'document.cookie = "k=v; max-age=86400"' }, api);
      await sleep(35_000); // Chromium writes cookies to disk every 30 s, and a stop does not flush them

      await dockerCli(["restart", config.name]);
      await serve();
      expect(await cookie()).toContain("k=v");

      await dockerCli(["stop", config.name]);
      await dockerCli(["rm", config.name]);
      await run(computer, { action: "screenshot" }, api); // recreates it on the same volume
      await serve();
      expect(await cookie()).toContain("k=v");
    }, 300_000);

    test("an operator job, with scripted model calls, opens a page and reports its heading", async () => {
      const { daemon, faux, home } = await bootTest({}, [desktopExtension(config)]);
      mkdirSync(join(home, "desktop/shared"), { recursive: true });
      writeFileSync(join(home, "desktop/shared/page.html"), PAGE_HTML); // a new home recreates the container
      script(faux, (role, text) => {
        const heading = role === "toolResult" ? text.match(/heading "([^"]+)"/) : null;
        return text === "go" ? call("job_start", { title: "Open", worker: "operator", brief: "open the page" })
          : text === "open the page" ? call("browser", { action: "navigate", url: PAGE })
          : heading ? call("job_complete", { summary: `The heading is ${heading[1]}` })
          : undefined;
      });
      await ask(daemon, "go");
      await waitFor(async () => (await reported(daemon)).some((r) => r.includes("The heading is Hello japa")), 120_000);
      await daemon.close();
    }, 300_000);
  });
});
