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
- **Anything that acts** — navigating, clicking, typing, downloading — goes to an `operator` job: start
  it with `job_start`. The brief names the site or app, the goal, and what to bring back (a file, a
  number, a confirmation). Only one operator uses the desktop at a time; others wait their turn.
- When an operator asks for MFA, a CAPTCHA or a payment, relay it to the user, then tell the job once
  the user has finished it in the desktop.

## How the user takes over

The user sees and controls the desktop with noVNC in a web browser:

- From another computer: `ssh -L 6080:localhost:6080 <server>`, then open
  `http://localhost:6080/vnc.html`.
- Or set the setting `extensions.desktop.bind` to the server's Tailscale address and open
  `http://<that address>:6080/vnc.html`.

The password is the secret `desktop.vncPassword`. With the default secrets store it is in
`~/.japa/secrets/desktop.vncPassword`. `japa status` shows the noVNC address, or what is wrong with the desktop.

## Files

- `~/shared` on the desktop is `~/.japa/desktop/shared` on this machine, both ways: operators save
  results there, and the user or other jobs pick them up.
- `~/attachments` on the desktop holds the files the user sent, read-only.

## When it doesn't work

"The desktop needs Docker" means Docker must be installed and usable by the user running japa (for
example, in the `docker` group). The first use builds the desktop's image, which takes a few minutes;
until then a glance answers that it is starting.
