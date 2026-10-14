// End to end: a real Docker-mode instance in a Sysbox system container (docs/spec.md §8). Gated behind
// JAPA_SYSBOX_TESTS=1 and needs Docker with the sysbox-runc runtime on the host, plus network access to clone
// JAPA_SYSBOX_TEST_REPO (default the real japa repo) at JAPA_SYSBOX_TEST_BRANCH (default main).
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));
const REPO = process.env.JAPA_SYSBOX_TEST_REPO ?? "https://github.com/Darryl-Shi/japa.git";
const BRANCH = process.env.JAPA_SYSBOX_TEST_BRANCH ?? "main";

const NAME = `japa-e2e-${randomBytes(4).toString("hex")}`;
const CONTAINER = `japa-${NAME}`;
const VOL_HOME = `${CONTAINER}-home`;
const VOL_DOCKER = `${CONTAINER}-docker`;
const NETWORK = `${CONTAINER}-net`;

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 300_000 });
const dockerOut = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 300_000 }).trim();

/** Runs `cmd` as japa inside the instance, with its user manager's environment. */
const asJapa = (...cmd: string[]) =>
  docker("exec", "-u", "japa", "-w", "/home/japa", "-e", "HOME=/home/japa", "-e", "XDG_RUNTIME_DIR=/run/user/1000", CONTAINER, ...cmd);

describe.skipIf(process.env.JAPA_SYSBOX_TESTS !== "1")("Docker mode with Sysbox (end to end)", () => {
  const home = mkdtempSync(join(tmpdir(), "japa-sysbox-home-"));
  const launcher = join(home, ".local", "bin", "japa");
  const env = {
    ...process.env,
    HOME: home,
    USER: "japa-e2e",
    PATH: [join(home, ".local", "bin"), dirname(process.execPath), process.env.PATH ?? "/usr/bin:/bin"].join(":"),
    JAPA_INSTANCE: "",
  };
  const runLauncher = (...args: string[]) => spawnSync(launcher, args, { encoding: "utf8", env, input: "", timeout: 300_000 });

  beforeAll(() => {
    const r = spawnSync("setsid", ["-w", "sh", INSTALL_SH, "--mode", "docker", "--instance", NAME, "--repo", REPO, "--branch", BRANCH, "--skip-setup"], {
      encoding: "utf8",
      env,
      input: "",
      timeout: 1_700_000,
    });
    if (r.status !== 0) throw new Error(`install.sh failed (${r.status}):\n${r.stdout}${r.stderr}`);
  }, 1_800_000);

  afterAll(() => {
    docker("rm", "-f", CONTAINER);
    docker("network", "rm", NETWORK);
    docker("volume", "rm", "-f", VOL_HOME, VOL_DOCKER);
  }, 300_000);

  test("the container runs under sysbox-runc with only its two volumes and two loopback ports", () => {
    const [info] = JSON.parse(dockerOut("container", "inspect", CONTAINER)) as Array<{
      HostConfig: { Runtime: string; Privileged: boolean; Binds: string[] | null; RestartPolicy: { Name: string } };
      Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
      NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>; Networks: Record<string, unknown> };
      Config: { Labels: Record<string, string>; Hostname: string };
    }>;
    expect(info.HostConfig.Runtime).toBe("sysbox-runc");
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    expect(info.HostConfig.RestartPolicy.Name).toBe("unless-stopped");
    expect(info.Mounts.filter((m) => m.Type === "bind")).toEqual([]);
    expect(info.Mounts.map((m) => `${m.Type}:${m.Name}:${m.Destination}`).sort()).toEqual([
      `volume:${VOL_DOCKER}:/var/lib/docker`,
      `volume:${VOL_HOME}:/home/japa`,
    ]);
    expect(JSON.stringify(info)).not.toContain("docker.sock");
    const published = (port: string) => info.NetworkSettings.Ports[port] ?? [];
    expect(Object.values(info.NetworkSettings.Ports).flatMap((b) => b ?? []).length).toBe(2);
    expect(published("16080/tcp")).toEqual([{ HostIp: "127.0.0.1", HostPort: info.Config.Labels["japa.desktopPort"] }]);
    expect(published("17337/tcp")).toEqual([{ HostIp: "127.0.0.1", HostPort: info.Config.Labels["japa.webuiPort"] }]);
    expect(info.Config.Labels["japa.webuiBind"]).toBe("127.0.0.1");
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([NETWORK]);
    expect(info.Config.Labels["japa.instance"]).toBe(NAME);
    expect(info.Config.Labels["japa.branch"]).toBe(BRANCH);
    expect(info.Config.Hostname).toBe(CONTAINER);
  });

  test("the host launcher forwards `--version` into the instance", () => {
    expect(readFileSync(launcher, "utf8")).toContain("# japa-docker-launcher");
    const r = runLauncher("--instance", NAME, "--version");
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^japa /);
  });

  test("`japa instances` lists it", () => {
    const r = runLauncher("instances");
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^${NAME}\\s+running\\s+${BRANCH}\\s+japa `, "m"));
  });

  test("bubblewrap works inside", () => {
    const r = asJapa("bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true");
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const plain = asJapa("bwrap", "--ro-bind", "/", "/", "true");
    expect(plain.status, `${plain.stdout}${plain.stderr}`).toBe(0);
  });

  test("the inner Docker works for japa", () => {
    const r = asJapa("docker", "info");
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  test(
    "`docker restart` keeps the home volume's data",
    () => {
      const marker = `kept-${randomBytes(4).toString("hex")}`;
      expect(asJapa("sh", "-c", `echo ${marker} > /home/japa/e2e-marker`).status).toBe(0);
      expect(docker("restart", CONTAINER).status).toBe(0);
      let state = "";
      for (let i = 0; i < 120; i++) {
        state = docker("exec", CONTAINER, "systemctl", "is-system-running").stdout.trim();
        if (state === "running" || state === "degraded") break;
        execFileSync("sleep", ["1"]);
      }
      expect(["running", "degraded"]).toContain(state);
      expect(asJapa("cat", "/home/japa/e2e-marker").stdout.trim()).toBe(marker);
      const r = runLauncher("--instance", NAME, "--version");
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    },
    300_000,
  );

  test(
    "uninstall removes the container and network and keeps the volumes",
    () => {
      const r = runLauncher("--instance", NAME, "uninstall");
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(VOL_HOME);
      expect(docker("container", "inspect", CONTAINER).status).not.toBe(0);
      expect(docker("network", "inspect", NETWORK).status).not.toBe(0);
      expect(docker("volume", "inspect", VOL_HOME).status).toBe(0);
      expect(docker("volume", "inspect", VOL_DOCKER).status).toBe(0);
      // Other japa instances on this host would keep the launcher; with none left, it's removed.
      const others = dockerOut("ps", "-a", "--filter", "label=japa.instance", "--format", "{{.Names}}");
      expect(existsSync(launcher)).toBe(others !== "");
    },
    300_000,
  );
});
