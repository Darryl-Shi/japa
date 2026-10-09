---
name: building-skills
description: Use when writing or changing a skill (a SKILL.md procedure that agents load with skill_read).
---

# Building skills

A skill is written know-how: how to do a procedure with tools that already exist. If it needs a new
tool, it's an extension (see `building-extensions`).

Your `~/.japa` is a private copy for this job. When you finish, your changes under
`~/.japa/skills/<name>` go live if `japa check` passes (below); changes elsewhere in `~/.japa` are
dropped. You don't install anything yourself.

## Format

Write `~/.japa/skills/<name>/SKILL.md`:

```markdown
---
name: team-update
description: Use when drafting the user's weekly team update.
---

# Team update

1. ...
```

- `name` is kebab-case and equals the directory name.
- `description` says *when* to load the skill, in one line. Agents see only the name and description
  in their skills list ("- name: description"), and load the body with `skill_read({ name })` when it
  fits, so make the description specific.
- The body is the procedure: short numbered steps, the exact tool names and arguments, what a good
  result looks like, and the common mistakes. Write it for an agent, not a person.
- Only use tools that exist; your capabilities and tools list show them.

## Progressive disclosure

Keep SKILL.md short (a few hundred words). Put long reference material, templates and examples in
extra files next to it, such as `skills/<name>/template.md`, and point to them by relative path in
the body ("For the layout, read `template.md`"). The reader loads one with
`skill_read({ name: "<name>", file: "template.md" })`, or with `read` when it knows the full path.
Only files inside the skill's directory can be read this way.

## Scripts

A skill may ship scripts, such as `skills/<name>/scripts/report.sh`, for steps that are better done
by code. Jobs can run them with `bash`; the chief of staff cannot run commands. Refer to a script by
its path relative to the skill's directory, `scripts/<file>`, the same path `skill_read` takes; that
directory is `skills/<name>/` in japa's home or in the bundling extension. Keep scripts small, with
no dependencies beyond the system: a job can't install system packages.

## Skills in an extension

An extension can bundle skills as `extensions/<extension>/skills/<name>/SKILL.md`; they load with the
extension.

## Check

From `~/.japa`, run

```
japa check skill <name>
```

It checks that SKILL.md exists, that `name` matches the directory and that `description` is present,
and prints `ok` when it passes. The same check runs when you finish: if it fails, nothing goes live.
