---
name: building-workers
description: Use when writing or changing a worker profile (workers/<name>.md), the setup a background job runs with.
---

# Building workers

A worker profile turns existing tools, models and environments into a new kind of background worker.
If it needs a tool that doesn't exist, build an extension first (see `building-extensions`).

## Format

Write `workers/<name>.md` in the current directory (the staging copy of `~/.japa`):

```markdown
---
name: dependency-watcher
description: Checks code projects for outdated dependencies.
tools: [read, bash]
extensions: [web]
skills: [research]
---

You check the projects named in the brief for outdated dependencies. ...
```

The header is one `key: value` line per field; lists are `[a, b]`, maps `{ provider: p, modelId: m }`.

| Field | Meaning | Default |
|-------|---------|---------|
| `name` | kebab-case; equals the file name | required |
| `description` | one line; the chief of staff picks workers by it | required |
| `model` | `{ provider, modelId }` | settings `models.worker`, else `models.cos` |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` | not set |
| `environment` | where its tools run | `local` |
| `tools` | built-in tools: `read`, `write`, `edit`, `bash` | none |
| `extensions` | extensions whose tools and sections it gets; `[]` for none | all |
| `skills` | skills listed for it; `[]` for none | all |
| `cwd` | working directory; a leading `~` or `$JAPA_HOME` is expanded | the environment's (`local`: the user's home directory) |

The body is the worker's instructions. Every worker also gets `job_progress`, `job_complete` and
`skill_read`. To ask something, a worker ends its turn with one clear question; the chief of staff
answers with `job_message`.

## Choosing the tools

Give the fewest tools the role needs:
- Reads and reports: `[read]`. Writes report files: `[read, write]`.
- Changes files: `[read, write, edit]`; add `bash` only to run commands (tests, builds, scripts).
- List only the extensions it needs, and the skills it uses.

The body says where to work, how to verify, what not to touch, and what `job_complete` must contain.

## Check

From the staging directory, run

```
../node_modules/japa/src/cli/main.ts check worker <name>
```

(the same as `japa check worker <name>` run there). It checks the fields, that `name` matches the
file name and that the model, environment, tools, extensions and skills exist. It prints `ok` on
success.
