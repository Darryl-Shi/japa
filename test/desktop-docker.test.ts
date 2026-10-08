import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { desktopContainer, dockerCli } from "../extensions/desktop/container.ts";
import { stubKernel } from "./desktop-helpers.ts";

// Task 7 adds to this describe.
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
