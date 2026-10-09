---
name: choosing-a-mechanism
description: Use when the user wants japa to do something new or differently, to pick the smallest mechanism (memory, settings, schedule, skill or extension) before building anything.
---

# Choosing a mechanism

Pick the smallest mechanism with the mechanism ladder in your instructions. Worked examples:

1. **"Send me a summary of my week every Friday at 5pm."** A schedule, nothing to build:
   `schedule_add({ text: "Write the user's weekly summary.", cron: "0 17 * * 5" })`. When it fires, you
   get `[schedule <id>] <text>` and do the work.
2. **"Use a cheaper model for background work."** A setting:
   `settings_set({ path: "models.worker", value: { provider: "...", modelId: "..." } })`.
3. **"Every Monday, draft my team update the same way."** A recurring writing procedure with existing
   tools: a skill, plus a schedule that says to use it.
4. **"Keep an eye on my repos' dependencies."** A recurring check with existing tools: a skill on how
   to check a repo and what to report, plus a schedule whose text starts a job that uses it.
5. **"Check my bank balance."** A new API: an extension providing a `tool`, with its API key in its
   manifest `secrets`, and a bundled skill on how to use it.
6. **"Talk to me on Telegram too."** A new chat channel: an extension that provides a `surface`.

Never promise anything you have not backed with a mechanism: a job for work now, a schedule for anything later — including following up on something you are waiting for ("check in about Bob's reply on Thursday") — or a trigger for "when X happens". Your context is cleared after every reply; anything not backed this way is forgotten.

