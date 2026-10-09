---
name: using-the-desktop
description: Use when a task involves japa's own desktop computer — websites, the browser or desktop apps — or the user asks how to see or take over the desktop.
---

# Using the desktop

japa has its own computer: a Linux desktop in a Docker container, with Chromium and other apps. Its
browser keeps its logins between jobs.

## Glance yourself, delegate acting

- **Glance yourself.** To see what's there, call `computer` with a screenshot, or `browser` with a
  snapshot (or text, or a screenshot). Reads work from anywhere.
- **Anything that acts** — navigating, clicking, typing, downloading — is for a job: start one with
  `job_start`. Any job can act on the desktop. The brief names the site or app, the goal, and what to
  bring back (a file, a number, a confirmation). One job uses the desktop at a time; the others wait
  their turn (their progress says which job has it).
- When a job asks for MFA, a CAPTCHA or a payment, relay it to the user, then tell the job once
  the user has finished it in the desktop.

## Operating it (in a job)

- The desktop is another computer. Your `bash`, `read`, `write` and `edit` act on this machine, not
  the desktop; `computer` and `browser` act on the desktop.
- Prefer `browser` for web pages. Use `computer` for other apps, for what the browser tool can't
  reach (canvas, browser extensions, native dialogs), or when an action by ref fails.
- Look before you act, and verify after: check the state each action returns before the next one,
  and zoom in to read small text.
- For MFA, CAPTCHAs, payments that need the user's device, or anything else only the user can do,
  call `job_ask` asking the user to finish it in the desktop. Continue when the chief of staff tells
  you it's done.
- Software installed with apt on the desktop is lost when it is upgraded; everything under its home
  directory is kept.
- In `job_complete`, say what was done, where the results are, and anything left undone.

## How the user takes over

The user sees and controls the desktop with noVNC in a web browser:

- From another computer: `ssh -L 6080:localhost:6080 <server>`, then open
  `http://localhost:6080/vnc.html`.
- Or set the setting `extensions.desktop.bind` to the server's Tailscale address and open
  `http://<that address>:6080/vnc.html`.

The password is the secret `desktop.vncPassword`. With the default secrets store it is in
`~/.japa/secrets/desktop.vncPassword`. `japa status` shows the noVNC address, or what is wrong with the desktop.

## Files

- `~/shared` on the desktop is `~/.japa/desktop/shared` on this machine, both ways, and a job sees
  the real folder there. Save files meant for the user or for other jobs to it.
- To upload a file in the browser, put it in `~/.japa/desktop/shared` and upload it from
  `~/shared/<name>`: `browser`'s upload takes paths on the desktop.
- `~/attachments` on the desktop holds the files the user sent, read-only; on this machine they are
  in `~/.japa/attachments` (read-only in a job).

## When it doesn't work

"The desktop needs Docker" means Docker must be installed and usable by the user running japa (for
example, in the `docker` group). The first use builds the desktop's image, which takes a few minutes;
until then a glance answers that it is starting.
