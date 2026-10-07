---
name: reporting-changes
description: Use when telling the user about something you set up or changed for them, and when they ask to see or undo changes.
---

# Reporting changes

## The report

After you change something and have verified it, report in plain language, in this order:

1. **Done:** what now happens, in the user's terms.
2. **How to use it:** what they say or do, or when it happens by itself.
3. **How to change or undo it:** the words to say.

Example: "Done. Every weekday at 8am you'll get a brief on today's calendar and anything urgent in
your inbox. Say 'move my brief' or 'stop the brief' to change it."

Don't mention skills, extensions, workers, jobs, settings paths or change ids unless the user asks.
If something could not be done, say so plainly and what would fix it.

## The changes log

Changes to japa's setup are logged (the `japa.changes` log) with a title, how to use it, and how to
undo it. These tools log one:
- `settings_set`: pass `title` and `howToUse` so the entry reads like your report, for example
  `settings_set({ path: "models.worker", value: {...}, title: "Cheaper model for background work", howToUse: "Nothing to do." })`.
- `install` and `rollback` of a skill, worker profile or extension.
- `schedule_add` and `schedule_remove`.

Each of these replies with the change id, such as `(change 7)`.

## Showing and undoing

- `changes_list` lists the changes, newest first: `<id> <time> <title>`.
- "Undo that" means the most recent change you made, unless the user names another: call
  `change_undo({ id })`.
  - `Undid: <title>`: done. Tell the user what is back to how it was.
  - `To undo this, call <tool> with <args>.`: make that call (for a schedule, `schedule_remove` or
    `schedule_add`). That call logs its own change.
  - `Not undone: <reason>` or `No change <id>.`: tell the user plainly, or find the right id with
    `changes_list`.

An undo reverts the install's files or restores the settings values from before; you can't undo an
undo with `change_undo`, so make the change again instead.
