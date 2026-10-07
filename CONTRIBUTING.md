# Contributing

Japa is intentionally small. Prefer a plain function or an extension over a new framework. Read the [architecture](ARCHITECTURE.md) before changing a core boundary.

## Local development

Use Node.js 24+ and npm:

```sh
npm ci
npm run check
npm test
```

`npm start` runs the source checkout. `./install.sh` makes a separate app copy; changing source files does not update that installed copy until you reinstall. Tests do not require provider credentials. Node's experimental SQLite warning is expected.

Use a temporary `JAPA_HOME` for manual experiments. Workers execute trusted code with local process privileges: do not test against valuable files or production accounts.

## Code map

| Location                                    | Responsibility                                              |
| ------------------------------------------- | ----------------------------------------------------------- |
| `src/core/contracts.ts`                     | Eight adapter interfaces and shared values                  |
| `src/core/settings.ts`                      | Channel-rendered, non-conversational setup protocol         |
| `src/core/host.ts`                          | Composition, explicit bindings, registration, lifecycle     |
| `src/core/loader.ts`                        | Trusted source validation, build/probe, activation/recovery |
| `src/defaults.ts`                           | Default product composition                                 |
| `src/extensions/assistant.ts`               | Root role, coordination tools, context reset                |
| `src/extensions/messaging.ts`               | Durable admission, replies, originating addresses           |
| `src/extensions/jobs.ts`                    | Workers, deadlines, history, reporting                      |
| `src/extensions/wakes.ts`                   | One-shot wakes and event hooks                              |
| `src/extensions/context.ts`                 | Bounded executive brief and projection                      |
| `src/extensions/memory.ts`                  | Reflective file and one-time legacy migration               |
| `src/extensions/state.ts`                   | Commitments, focus, and ingress receipts                    |
| `src/extensions/policy.ts`, `approvals.ts`  | Tool decisions and durable approvals                        |
| `src/extensions/setup.ts`, `models.ts`      | Native provider login, credentials, selections              |
| `src/extensions/terminal.ts`, `telegram.ts` | Channel transports and shared settings rendering            |
| `src/extensions/computer.ts`, `self.ts`     | Packaged environment and self-extension                     |
| `src/cli.ts`                                | Home ownership, setup, startup/shutdown                     |
| `src/index.ts`                              | Public exports                                              |

## Keep these invariants

1. **Root coordinates.** It must not inherit worker coding or generated tools. A worker gets a self-contained brief and fresh conversation, not the root's private transcript.
2. **Reuse native durability.** Use Pi tasks, documents, ownership, and checkpoints; do not add a parallel workflow engine. Stable operation keys must survive retries.
3. **Keep promises separate from attempts.** A worker's final answer does not prove the commitment is fulfilled. Preserve evidence and blockers for review.
4. **Bound active context.** Keep tool-call/result groups intact. On projection failure, fail closed instead of falling back to the whole transcript.
5. **Keep memory small.** Reflection rewrites one note. Job history carries detailed execution records. Do not grow a fact-extraction/indexing platform by default.
6. **No fixed proactive policy.** Give the chief of staff wake primitives; let it decide cadence and when to interrupt. No implicit timer is created merely by recording a due date.
7. **Keep setup outside model conversation.** Every channel renders the shared settings protocol; secret entry and OAuth callbacks must never pass through normal ingress. Honor prompt cancellation, serialize credential refresh, and disclose transport privacy limits.
8. **Be honest about effects.** `replay: "safe"` requires real idempotency or acceptable repetition. Probes, policy, and registration restrictions are not sandboxes.
9. **Keep integrations optional.** Build reusable capabilities as extensions. App-specific logic does not belong in core.

Exact APIs live in the TypeScript contracts, not the archived architecture proposal.

## Test by behavior

Use `test/helpers.ts` for deterministic faux models, temporary homes, channels, SQLite fixtures, and reopening. Tests should not call live models or external app accounts.

| Tests                                      | What they establish                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `host.test.ts`                             | Provider binding, lifecycle cleanup, context failure behavior                    |
| `assistant.test.ts`, `context.test.ts`     | Delegation, role boundaries, steering, bounded continuity                        |
| `jobs.test.ts`, `wakes.test.ts`            | Search, wake admission, silence/notification, restart, cancellation              |
| `memory.test.ts`                           | Complete rewrites, conflicts, direct edits, migration, persistence               |
| `policy.test.ts`                           | Address-bound approvals, restart behavior, denied effects                        |
| `loader.test.ts`                           | Actual TypeScript/bundle/probe behavior and activation recovery                  |
| `recovery.test.ts`, `crash-child.ts`       | Real process kill/restart, not just a mocked restart                             |
| `setup.test.ts`                            | Native auth bridge, persistence, refresh serialization, overrides, cancellation  |
| `terminal.test.ts`, `cli.test.ts`          | Hidden input, terminal echo ordering, CLI startup, noninteractive safeguards     |
| `telegram.test.ts`, `telegram-cli.test.ts` | Owner restrictions, polling/checkpoints, setup isolation, CLI settings lifecycle |
| `install.test.ts`                          | Staging, path quoting, dependency failures, protection of unrelated paths        |
| `docs.test.ts`                             | Local documentation links and heading anchors                                    |

A passing faux-model test establishes runtime behavior, not real-model judgment. Live OAuth, subscription entitlement, task quality, and arbitrary integrations need separate explicit smoke tests in a dedicated environment. Never represent fixture success as those validations.

Useful focused commands:

```sh
npx tsx --test test/wakes.test.ts test/jobs.test.ts
npx tsx --test test/setup.test.ts test/terminal.test.ts
```

## Before committing

```sh
npm run format
npm run check
npm test
bash -n install.sh
git diff --check
```

Review both the working diff and the staged diff. Keep commits coherent and describe what their snapshots actually contain. Do not fabricate development dates or rewrite unrelated branches to make the history look older or more incremental.

Do not commit homes, personal memory, credentials, SQLite state, environment files, logs containing secrets, or dependencies. The tests use obviously synthetic credentials; those fixtures are not real account tokens. Review new untracked paths before staging them.

For documentation changes, verify relative links and command examples. Maintain [README.md](README.md) as the short entry point, [ARCHITECTURE.md](ARCHITECTURE.md) as the implemented design, and `docs/` as focused guides. The archived proposal is historical evidence, not a target to implement or silently rewrite.

For dependency upgrades, review native Pi API changes and run the restart and extension-installation tests. Pi Durable is experimental; the three Pi packages are pinned together at the currently validated version.
