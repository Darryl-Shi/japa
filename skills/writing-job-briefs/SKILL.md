---
name: writing-job-briefs
description: Use when starting background jobs with job_start, to write a good brief, pick a model if needed, run jobs in parallel and follow up.
---

# Writing job briefs

A job sees only its brief, its instructions and its tools, not this conversation or the user's
memory. Put everything it needs in the brief.

## A good brief

`job_start({ title, brief })`, where `title` is a few words for the jobs board, and the brief
contains:

1. **Goal:** what to achieve and why, in one or two sentences.
2. **Context:** the facts it needs: names, paths, URLs, dates, the user's preferences, what was
   already tried.
3. **Constraints:** where to work, what not to touch, limits on time, cost or scope, and anything
   that needs the user's consent first (it should ask, not act).
4. **Done:** what "done" looks like and what the `job_complete` summary must contain, such as a
   short answer, a file path, or a list of changes.

Example: "Goal: find three dentists near the user accepting new patients. Context: the user lives in
Leith, Edinburgh and prefers Saturday appointments. Constraints: research only; don't contact
anyone. Done: a list with name, address, phone, Saturday hours and a source URL for each."

## What a job can do

Every job has `read`, `write`, `edit` and `bash`, every skill and every extension's tools. It runs in
a sandbox:

- It sees the user's files and the network, but its own copy of `~/.japa` (without japa's secrets
  or database) and its own `/tmp`. In that copy, the files the user sent (`~/.japa/attachments`)
  and the current `settings.json` are the real ones, read-only. Name the directory to work in.
- It can't use `sudo` (so no system packages), Docker, `systemctl --user` or the ssh agent, and
  can't change japa's own program or service. Ask the user for those.
- What it changes under `~/.japa/extensions` and `~/.japa/skills` goes live when it finishes, if it
  passes `japa check`; its report then ends with `Live: …` or `Not live: …`. Its other changes to
  `~/.japa` are dropped, and that line ends with `Dropped: …` naming them. A job that changed only
  such files ends `Not live: the job changed nothing under extensions/ or skills/. … Dropped: …`;
  one that changed nothing in `~/.japa` has no outcome line. Settings change through
  `settings_set`, not jobs.
- To retry a job that ended `Not live: … Kept at <path>.`, start a new job with what failed. A job
  can't see `<path>` (its own `~/.japa` covers it): read the files that matter there yourself and put
  them, or what to change, in the brief.

## Model and thinking

A job runs on the worker model (`models.worker`, else the chief of staff's) and thinks at
`jobs.thinking`. Pass `model: "<provider>/<modelId>"` or `thinking` (`off` to `xhigh`) only when the
work needs a stronger or cheaper setup than that.

## Parallel jobs

Independent pieces of work go in separate jobs started together, one per question, source or
project. Don't split steps that depend on each other. At most `jobs.maxConcurrent` jobs (a setting)
run at once; the rest queue.

## Following up

- `job_list` shows every job and its status; `job_transcript({ id, tail })` shows its last messages.
- `job_message({ id, text, mode: "steer" })` redirects a running job. A job whose changes are going
  live can't be messaged until its report arrives.
- When a job reports back with a question (it needs input), or you want more from a finished job,
  answer with `job_message({ id, text, mode: "followup" })`.
- `job_stop({ id })` cancels a job that is no longer needed; it reports nothing more.

Never promise anything you have not backed with a mechanism: a job for work now, a schedule for anything later — including following up on something you are waiting for ("check in about Bob's reply on Thursday") — or a trigger for "when X happens". Your context is cleared after every reply; anything not backed this way is forgotten.
