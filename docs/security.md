# Security

japa's runtime keeps three things nobody else holds: the state of every conversation, your keys, and your consent. The lines below are held there.

## Who gets in

- Every channel's messages go through the same gate, its platform's Inbox, which refuses anyone not on the allowlist.
- The allowlist is edited only in `settings.json`. No tool of japa's changes it, so a message can't widen it. The agent's shell is on the same machine, so against the agent itself this holds through the review of its actions, not the machine.

## Keys

- Model credentials live in pi's `auth.json`, set with `/login`. Extension keys live in `secrets.json`, set with a secret field in `/settings`. Neither is in code or `settings.json`.
- The agent's commands don't get japa's keys in their environment. A key a command needs is passed to that one command.

## Code japa didn't ship

- Shell, files and the screen are the machine japa runs on, in the agent's home, as the user japa runs as. So install japa where you're happy for the agent to have a shell: a machine of its own, not one you use for anything else.
- Extensions run inside japa, the built-in ones and those installed from chat alike, with the Host and its keys. An installed one has nothing a built-in lacks, and nothing taken away.
- So your tap is the line. Before you're asked, the code is checked without running it: where it starts, that its imports resolve, and its own npm packages installed without running their scripts. The install card says where it came from, its size, the web addresses in it and its packages, and only your tap installs it, whatever the approvals mode.

## Actions

- Every tool call that acts is reviewed first: on the machine (reading and writing files included) or beyond it (the web included). Only tools that touch nothing but the agent's own state (its memory, open items and jobs) skip it. Anything that sends as you, spends, deletes your things, deploys or changes accounts waits for your Approve, Deny or Always.
- Standing permissions come only from your "Always" taps, and can be removed in `/settings`.
- Every reviewed call is written to `audit.jsonl`.
