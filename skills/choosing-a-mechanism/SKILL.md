---
name: choosing-a-mechanism
description: Use when the user wants japa to do something new or differently, to pick the smallest mechanism (memory, settings, skill, worker profile or extension) before building anything.
---

# Choosing a mechanism

Use the smallest mechanism that meets the need; stop at the first row that fits:

| Need | Mechanism |
|------|-----------|
| A fact or preference about the user | memory: `memory_remember` |
| Adjust something that already exists | settings: `settings_set`, or a schedule with `schedule_add` |
| A procedure or know-how using existing tools | skill (content) |
| A new kind of worker from existing tools, models and environments | worker profile (content) |
| Connect to something new, or enforce a guarantee rather than give guidance | extension implementing a contract |

The test: if existing tools plus written instructions can do it, it's content. Often it's both: an
extension provides the tool and bundles a skill that teaches when and how to use it.

## Worked examples

1. **"Send me a summary of my week every Friday at 5pm."** A schedule, nothing to build:
   `schedule_add({ text: "Write the user's weekly summary.", cron: "0 17 * * 5" })`. When it fires, you
   get `[schedule <id>] <text>` and do the work.
2. **"Use a cheaper model for background work."** A setting:
   `settings_set({ path: "models.worker", value: { provider: "...", modelId: "..." } })`.
3. **"Every Monday, draft my team update the same way."** A recurring writing procedure with existing
   tools: a skill, plus a schedule that says to use it.
4. **"Keep an eye on my repos' dependencies."** A specialised background role from existing tools: a
   worker profile with its own tools, skills and instructions.
5. **"Check my bank balance."** A new API: an extension providing a `tool`, with its API key in its
   manifest `secrets`, and a bundled skill on how to use it.
6. **"Talk to me on Telegram too."** A new chat channel: an extension that provides a `surface`.

## Then build it

Memory, settings and schedules you change yourself. For a skill, worker profile or extension, start
one `builder` job at a time with `job_start`, with a brief stating the requirement and the chosen
mechanism. When it completes, call `install({ kind, name })`, verify with a real dry run, then
report (see `reporting-changes`). If the install fails, retry through the builder or tell the user
plainly.
