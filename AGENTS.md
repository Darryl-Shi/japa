# Working on japa

japa is meant to be customized: every user brings their own channel, models, machines and extensions. Write code that
keeps it that way.

- **Don't hardcode anything.** No keys, names, hosts, paths, models, channels or providers in code or prompts. Read them
  from settings, secrets, pi's credential store, or live state. Telegram is the default channel, not an assumption: a
  prompt says "the user" and "the conversation", never "Telegram".
- **Don't add abstractions it doesn't need.** Extend the one extension shape (`JarvisExtension`) and the Host before
  inventing a new kind of thing; the backend is the only other one.
- **Don't give up flexibility, and don't assume a working path.** Resolve locations from where things actually are
  (the code's own directory, the configured data dir, the workbench's home), never a fixed directory like
  `~/.pi/agent/extensions` or `/tmp/japa`.

For example: a model provider added by an extension takes its key from `/settings` → Model keys (stored where pi keeps
credentials), not from a constant in the extension or an env var on one server.
