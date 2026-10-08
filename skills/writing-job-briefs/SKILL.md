---
name: writing-job-briefs
description: Use when starting background jobs with job_start, to write a good brief, pick the worker, run jobs in parallel and follow up.
---

# Writing job briefs

A worker sees only its brief, its profile's instructions and its tools, not this conversation or
the user's memory. Put everything it needs in the brief.

## A good brief

`job_start({ title, brief, worker })`, where `title` is a few words for the jobs board, and the brief
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

## Choosing the worker

Pick by description from the workers in your capabilities: for example `researcher` for web research,
`coder` for changing files and running commands, `builder` for building japa's own skills, workers
and extensions, and `general` (the default when `worker` is omitted) for the rest. If none fits and
the need recurs, consider a new worker profile.

## Parallel jobs

Independent pieces of work go in separate jobs started together, one per question, source or
project. Don't split steps that depend on each other. At most `jobs.maxConcurrent` jobs (a setting)
run at once; the rest queue. Start only one `builder` job at a time.

## Following up

- `job_list` shows every job and its status; `job_transcript({ id, tail })` shows its last messages.
- `job_message({ id, text, mode: "steer" })` redirects a running job.
- When a job reports back with a question (it needs input), or you want more from a finished job,
  answer with `job_message({ id, text, mode: "followup" })`.
- `job_stop({ id })` cancels a job that is no longer needed; it reports nothing more.

Never promise anything you have not backed with a mechanism: a job for work now, a schedule for anything later — including following up on something you are waiting for ("check in about Bob's reply on Thursday") — or a trigger for "when X happens". Your context is cleared after every reply; anything not backed this way is forgotten.
