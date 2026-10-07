# Japa

A small, self-extensible AI chief of staff built on **Pi Durable 1.0.4**.

One root conversation understands the user, delegates work, tracks promises, and reviews outcomes. Fresh workers do the execution. The root stays available while they work.

**One TypeScript package. One host process. One SQLite database. Eight replaceable adapters.** No second workflow engine, application web server, or message broker.

This is a working backend foundation, not a finished Dots clone. The current interface is a terminal.

## Start

Requires **Node.js 24+** and npm. The installer also requires Bash and standard filesystem utilities.

From this checkout:

```sh
./install.sh
```

It installs a private app copy and a `japa` launcher, then opens setup when run interactively. Add `~/.local/bin` to your PATH if prompted. It requires no sudo and installs **no background service**.

First-run setup asks for OpenAI or Anthropic login/API-key authentication inside the interface. It chooses model defaults automatically. Credentials are not sent through chat.

For development, without installing a separate copy:

```sh
npm ci
npm start
```

Environment credentials remain supported for unattended use:

```sh
OPENAI_API_KEY=... npm start
# Or supply ANTHROPIC_API_KEY.
```

### Commands

| Command                        | Effect                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| `/settings`                    | Pause the host, edit provider/model settings, then resume         |
| `/approve <id>` / `/deny <id>` | Resolve a pending approval directly                               |
| `/exit`                        | Stop cleanly; pending work resumes next launch                    |
| `japa --setup`                 | Open settings before starting                                     |
| `japa --safe`                  | Skip generated-extension restoration while retaining repair tools |
| `japa --help`                  | Show startup options                                              |

For source runs, use `npm start -- --setup` or `npm start -- --safe`.

**Workers and generated extensions have the process's full privileges.** Run Japa in a dedicated account/container/VM and give it only credentials it should have. The workspace, tool policy, and extension probe are not sandboxes. Credentials are local plaintext with owner-only file permissions, not an OS keychain.

## What it does

- **Coordinates:** conversations, commitments, delegation, steering, cancellation, and result review. Worker completion does not automatically fulfill a promise.
- **Remembers simply:** a compact, human-editable `MEMORY.md`, maintained through reflection and revision-checked rewrites. No vector store or separate extraction service.
- **Retrieves past work:** searchable durable job history, without loading the whole history into every model request.
- **Chooses its own wakes:** durable one-shot follow-ups and reflection, silent by default. Extensions can also wake the chief of staff through an event hook. No fixed heartbeat.
- **Builds capabilities:** workers can write, check, and activate trusted TypeScript extensions. App integrations are intentionally not bundled; users ask the assistant to build what they need.
- **Recovers:** native Pi Durable tasks, conversations, documents, and checkpoints persist across process restart.

```text
User ⇄ Channel ⇄ Chief of staff → Jobs → Fresh workers → Computer / tools
                    ↑   │                    │
                    │   ├─ Commitments       └─ Results return to the root
                    │   ├─ MEMORY.md
                    │   └─ Searchable work history
                    └─ Self-chosen wakes / extension events

Core: contracts, settings protocol, lifecycle, trusted loader
Pi Durable: execution, persistence, ownership, recovery
```

The root has no shell, coding, or installation tools. Large material stays with workers and artifacts; the root reconstructs a bounded executive brief after each completed turn.

## Files and configuration

| Launch method            | Default state directory                      |
| ------------------------ | -------------------------------------------- |
| Installed `japa`         | `${XDG_STATE_HOME:-$HOME/.local/state}/japa` |
| Source `npm start`       | `./.japa`                                    |
| Either, with `JAPA_HOME` | The specified directory                      |

Set `JAPA_HOME` to reuse the same state when switching launch methods. Do not run two processes against one home.

```text
<JAPA_HOME>/
  japa.sqlite       Conversations, tasks, jobs, approvals, wakes, manifests
  MEMORY.md         Compact reflective personal memory
  settings.json     Provider/model selections and installation identity
  credentials.json  API keys or OAuth credentials
  workspace/        Worker files and artifacts
  extensions/       Generated sources and executable bundles
```

`JAPA_MODEL` and `JAPA_WORKER_MODEL` accept `provider/model` and override saved role selections for that run without replacing them. Defaults are OpenAI `gpt-5.4` / `gpt-5.4-mini`, or Anthropic `claude-sonnet-4-6` for both roles, subject to the native credential-filtered catalog.

See [operations](docs/OPERATIONS.md) for installation paths, authentication, backups, restoration, safe mode, and troubleshooting.

## Documentation

- [Architecture](ARCHITECTURE.md) — component graph, adapter boundaries, data ownership, and durability guarantees.
- [Extensions and adapters](docs/EXTENSIONS.md) — author capabilities, replace providers, implement channel settings, and use wake hooks.
- [Operations](docs/OPERATIONS.md) — installation, configuration, recovery, and trust boundaries.
- [Contributing](CONTRIBUTING.md) — code map, development workflow, tests, and design constraints.
- [Changelog](CHANGELOG.md) — implemented scope and intentional limitations.
- [Original proposal](docs/archive/architecture-proposal.md) — historical reference only, not the implementation contract.

The main entry points are [`Host`](src/core/host.ts), [`contracts`](src/core/contracts.ts), [`SettingsUI`](src/core/settings.ts), and [`defaultExtensions`](src/defaults.ts). [`examples/weather.ts`](examples/weather.ts) is an opt-in capability example, not an automatically installed integration.

## Development

```sh
npm ci
npm run check
npm test
npm run format
```

Tests use deterministic faux models and the real Pi Durable runtime, including SQLite reopen and actual `SIGKILL` recovery. They also exercise settings, credential refresh, hidden terminal input, wakes, installation, and capability activation. They do **not** establish live-provider entitlement, real-model task quality, or reliability of arbitrary integrations.

## Deliberate limits

- Wakes require a running process. Overdue wakes fire on restart; due dates alone do not schedule anything. No managed hosting, cron recurrence, or timezone/DST policy is included.
- External delivery is at-least-once unless the transport deduplicates. Arbitrary external actions are not made exactly-once by checkpointing.
- Forgetting changes personalization, not every historical copy. Raw transcripts, job records, and backups remain; this is not secure erasure.
- Generated code is trusted. Activation recovery cannot undo external actions or migrations, and ordinary runtime errors do not trigger automatic rollback.
- No web/Telegram channel, user-account authentication layer, voice, attachments, production multi-user isolation, billing, or comprehensive cost/retention policy is included.

Pi Durable is experimental; its dependencies are pinned. Keep the core small and add behavior through extensions.
