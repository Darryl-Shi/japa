# Security

japa's runtime keeps three things nobody else holds: the state of every conversation, your keys, and your consent. The lines below are held there.

## Who gets in

- Every channel's messages go through the same gate, its platform's Inbox, which refuses anyone not on the allowlist.
- The allowlist is edited only in `settings.json`. No tool can change it, so neither a message nor the agent itself can widen it.

## Keys

- Model credentials live in `auth.json`, set with `/login`. Extension keys live in `secrets.json`, set with a secret field in `/settings`. Neither is in code or `settings.json`.
- The workbench never holds a key. A key a coding agent needs is passed to that one command's environment.
- An extension installed from chat never sees a key. It gets a placeholder, and japa fills in the real value when a request to the web carries one: only the extension's own keys, masked again in the answer.

## Code japa didn't ship

- Shell, files and coding agents run on the workbench. Without a workbench, the agent has no shell at all.
- Extensions installed from chat run on the extensions machine, each in its own process. Before you're asked, the code is loaded there to see what it declares. The install card says what it would get, and only your tap installs it, whatever the approvals mode.
- Once installed, an extension can rewrite only its own tools' calls; for any other tool it can only block. It vouches only for its own tools as safe, and its cards' buttons are its own.
- Built-in extensions run inside japa. They ship with japa and change only through its code.

## Actions

- Every tool call is reviewed first. Anything that sends as you, spends, deletes your things, deploys or changes accounts waits for your Approve, Deny or Always.
- Standing permissions come only from your "Always" taps, and can be removed in `/settings`.
- Every reviewed call is written to `audit.jsonl`.
