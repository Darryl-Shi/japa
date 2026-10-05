# Security

japa's runtime keeps three things nobody else holds: the state of every conversation, your keys, and your consent. The lines below are held there.

## Who gets in

- Every channel's messages go through the same gate, its platform's Inbox, which refuses anyone not on the allowlist.
- The allowlist is edited only in `settings.json`. No tool can change it, so neither a message nor the agent itself can widen it.

## Keys

- Model credentials live in `auth.json`, set with `/login`. Extension keys live in `secrets.json`, set with a secret field in `/settings`. Neither is in code or `settings.json`.
- The workbench never holds a key. A key a coding agent needs is passed to that one command's environment.

## Code japa didn't ship

- Shell, files and coding agents run on the workbench. Without a workbench, the agent has no shell at all.
- Extensions run inside japa, the built-in ones and those installed from chat alike, with the Host and its keys. An installed one has nothing a built-in lacks, and nothing taken away.
- So your tap is the line. Before you're asked, the code is checked without running it: where it starts, that its imports resolve, and its own npm packages installed without running their scripts. The install card says where it came from, its size, the web addresses in it and its packages, and only your tap installs it, whatever the approvals mode.

## Actions

- Every tool call is reviewed first. Anything that sends as you, spends, deletes your things, deploys or changes accounts waits for your Approve, Deny or Always.
- Standing permissions come only from your "Always" taps, and can be removed in `/settings`.
- Every reviewed call is written to `audit.jsonl`.
