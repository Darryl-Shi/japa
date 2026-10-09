import { getSystemMessageText } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { loadSkills, skillAt } from "../src/kernel/skills.ts";
import { NO_BWRAP, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, jobs, reported, say, textOf, texts } from "./jobs-helpers.ts";

const skill = (name: string, description: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

/** Writes `<dir>/<name>/SKILL.md` for each entry; returns `dir`. */
function skillsIn(dir: string, skills: Record<string, string>): string {
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), text);
  }
  return dir;
}

const tempDir = () => mkdtempSync(join(tmpdir(), "japa-skills-"));

test("skillAt finds the skill loaded from a folder, whatever its name; none for a folder another one replaced", () => {
  const dir = skillsIn(tempDir(), { hello: skill("greeting", "Greets"), a: skill("a", "first"), z: skill("a", "last") });
  const { skills } = loadSkills([dir]);
  expect(skillAt(skills, join(dir, "hello"))?.name).toBe("greeting");
  expect(skillAt(skills, join(dir, "z"))?.description).toBe("last");
  expect(skillAt(skills, join(dir, "a"))).toBeUndefined();
  expect(skillAt(skills, join(dir, "missing"))).toBeUndefined();
});

test("later dirs override earlier ones; a bad skill is reported and skipped", () => {
  const packaged = skillsIn(tempDir(), { a: skill("a", "packaged"), bad: "---\nname: bad\n---\n" });
  const home = skillsIn(tempDir(), { a: skill("a", "home") });
  const { skills, errors } = loadSkills([packaged, join(packaged, "missing"), home]);
  expect([...skills.keys()]).toEqual(["a"]);
  expect(skills.get("a")).toEqual({
    name: "a",
    description: "home",
    dir: join(home, "a"),
    file: join(home, "a", "SKILL.md"),
  });
  expect(errors).toEqual([{ name: "skill:bad", error: expect.stringContaining("description") }]);
});

/** Boots with `<home>/skills` and an extension `bundle` with its own skill `b`. */
async function bootWithSkills() {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  skillsIn(join(home, "skills"), { a: skill("a", "Skill A", "Do A.") });
  writeFileSync(join(home, "skills", "a", "ref.md"), "Reference.");
  const bundle = join(home, "extensions", "bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "index.ts"), `export default { name: "bundle", summary: "Bundled skills" };\n`);
  skillsIn(join(bundle, "skills"), { b: skill("b", "Skill B") });
  const daemon = await boot({ home, extensions: [kit.extension] });
  return { daemon, faux: kit.faux };
}

const skillsSection = (system: string) => /<skills>\n([\s\S]*?)\n<\/skills>/.exec(system)?.[1];

test.skipIf(NO_BWRAP)("the root and every job see all skills", async () => {
  const { daemon, faux } = await bootWithSkills();
  const sections: Record<string, string | undefined> = {};
  faux.setResponses(
    Array.from({ length: 10 }, () => ({ messages }) => {
      const system = messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n");
      const last = textOf(messages.findLast((m) => m.role !== "system")!);
      sections[last] = skillsSection(system);
      if (last === "start") return call("job_start", { title: "A", brief: "brief" });
      if (last === "brief") return call("job_complete", { summary: "done" });
      return say("ok");
    }),
  );
  await ask(daemon, "start");
  await waitFor(async () => (await reported(daemon)).length > 0);
  // After the packaged skills.
  expect(sections.start).toMatch(/\n- b: Skill B\n- using-the-desktop: .*\n- a: Skill A\nLoad one with skill_read when it applies\.$/);
  expect(sections.brief).toBe(sections.start);
  expect((await jobs(daemon))["1"]!.status).toBe("done");
  await daemon.close();
});

test("skill_read returns the body or a file inside the skill, and refuses others", async () => {
  const { daemon, faux } = await bootWithSkills();
  const args: Record<string, string>[] = [{ name: "a" }, { name: "a", file: "ref.md" }, { name: "a", file: "../x" }, { name: "nope" }];
  faux.setResponses(args.flatMap((a) => [call("skill_read", a), say("ok")]));
  for (const a of args) await ask(daemon, JSON.stringify(a));
  expect(await texts(daemon.root, "toolResult")).toEqual([
    "Do A.",
    "Reference.",
    "Not part of skill a.",
    expect.stringMatching(/^No skill "nope"\. Skills: .*, b, using-the-desktop, a\.$/),
  ]);
  await daemon.close();
});

