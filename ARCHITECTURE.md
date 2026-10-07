# Implemented architecture

This document describes the current code, not a future product specification. The [original proposal](docs/archive/architecture-proposal.md) is archived; where it differs, the implementation and [contracts](src/core/contracts.ts) take precedence.

## Shape

One TypeScript package, one Node.js host process, one SQLite database. Japa uses Pi Durable conversations, documents, tasks, checkpoints, and ownership directly. There is no second workflow engine, message broker, service-discovery framework, or application web server. Tools and extension checks can spawn child processes.

```text
User ⇄ Channel ⇄ Durable ingress/reply tasks ⇄ Chief of staff (root)
         │                                          │
         └─ Settings UI                             ├─ Commitments and focus
            Provider login                          ├─ Reflective MEMORY.md
            (outside chat)                          ├─ Searchable job history
                                                    ├─ One-shot wakes
                                                    │
                                                    └─ JobRunner → Fresh workers
                                                                       │
                                                                Policy / approvals
                                                                       │
                                                               Computer + tools
                                                                       │
                                                              Capability installation

Root and workers → ModelProvider → Native Pi model collection

Default extensions: assistant behavior and adapter implementations
Core: contracts + settings protocol + host lifecycle + trusted loader
Pi Durable: conversations + tasks + documents + recovery → SQLite
Filesystem: MEMORY.md + settings + credentials + workspace + extension artifacts
```

Job reports and wake events return through durable ingress. The root reviews the result and communicates with the user. Policy also applies to the root's coordination tools; it is not exclusively a worker gate.

## Boundaries

### Core

[`src/core/host.ts`](src/core/host.ts) assembles extensions, binds providers, opens the native harness, installs contributions, starts resources, and closes them in reverse order. It does not decide how an assistant should behave.

Eight required adapter slots are defined in [`src/core/contracts.ts`](src/core/contracts.ts):

| Slot          | Contract                                  | Packaged implementation      |
| ------------- | ----------------------------------------- | ---------------------------- |
| `channel`     | Ingress, delivery, settings UI            | Terminal or private Telegram |
| `models`      | Native models plus root/worker selections | All native pi-ai providers   |
| `environment` | Native Pi environment factory             | Local filesystem and shell   |
| `context`     | Project the root's model input            | Bounded executive brief      |
| `memory`      | Read/rewrite a reflective note            | `MEMORY.md`                  |
| `jobs`        | Start/list/search/steer/cancel work       | Durable workers              |
| `policy`      | Allow, deny, or ask for a tool call       | Tool-name rules              |
| `approvals`   | Persist and resolve user decisions        | Address-bound chat approvals |

A missing provider fails startup. Multiple providers for a slot require an explicit binding by extension name. Factories are lazy; they cannot use open storage during construction. The settings protocol belongs to `Channel`, not a ninth adapter.

The trusted loader in [`src/core/loader.ts`](src/core/loader.ts) supplies capability installation infrastructure. The worker-facing tools and restoration lifecycle are packaged by `japa.self`.

### Default composition

[`src/defaults.ts`](src/defaults.ts) supplies the product behavior. Applications can replace its providers without changing core. The assistant extension starts channel ingress last, after memory initialization and generated-extension restoration.

Startup is:

1. CLI resolves and locks the home directory.
2. Channel settings obtain or restore provider authentication outside the conversation.
3. Host registers all contributions, validates model references, and opens Pi Durable.
4. Extension start hooks initialize resources; the assistant configures the root and starts ingress.
5. Native pending work resumes. Shutdown closes resources and the harness, then releases the home lock.

The library does not take the CLI's home lock for you.

Provider setup is shared logic over core `SettingsUI`, not a separate provider implementation per channel. Terminal and Telegram both render its choices, text prompts, progress, and cancellation. Telegram lazily polls for setup before a Host exists; normal chat only reaches durable ingress once the Host is ready. `/settings` pauses the Host and reconstructs the channel for setup. With no configured model, Telegram keeps only its setup/control interface alive and does not resume durable work.

The native registry includes static and dynamic providers. Japa uses provider auth metadata rather than assuming API-key and OAuth login are universally supported. Dynamic catalogs use Pi's `ModelsStore` interface; credential availability does not establish entitlement or tool-call support.

## Three different lifetimes

| Concept      | Meaning                           | Persistence                                                            |
| ------------ | --------------------------------- | ---------------------------------------------------------------------- |
| Relationship | Ongoing interaction with the user | Root transcript, memory note, conversational focus                     |
| Commitment   | A promised outcome                | `japa.assistant` document                                              |
| Job          | One execution attempt             | `japa.jobs`, a native background task, and a fresh worker conversation |

A completed worker is **not** proof that the user's outcome was achieved. It means the attempt returned an answer; the root must inspect evidence and update the commitment separately. A new attempt is another job, not a resurrected completed worker.

## Root and workers

The root selects only its assistant and policy extensions. It has eight tools:

| Tool                         | Purpose                                             |
| ---------------------------- | --------------------------------------------------- |
| `job_start`                  | Delegate a self-contained outcome                   |
| `jobs`                       | List/search history, inspect results, steer, cancel |
| `commitment` / `commitments` | Maintain and inspect promises                       |
| `focus`                      | Preserve a short conversational handoff             |
| `memory`                     | Read or rewrite the reflective note                 |
| `wake`                       | Schedule/list/cancel follow-up or reflection        |
| `notify`                     | Deliver useful news during a silent wake            |

Root does not receive shell, file, installation, or generated capability tools. Workers receive a fresh conversation and explicit brief, not the root transcript or its coordination tools. They can use the computer and build missing tools.

The role separation is a behavior boundary, **not a security sandbox**. Trusted workers and generated code have the process's privileges.

## Context and reflection

After a successful root response, a reset is queued at the completed-turn boundary. Historical entries remain in SQLite. The next request is reconstructed from:

- The current root instructions and tools.
- The complete compact memory note and its revision.
- Recent dialogue and conversational focus.
- Open commitments, relevant job statuses, pending wakes, and the current time.
- The active input and complete tool-call/result groups that fit the budget.

The default budget is **32,000 serialized characters**, not tokens. The projector never splits a retained tool exchange. It can omit an oversized exchange or shorten an oversized input. Operational summaries are omitted before the reflective note; counts tell the root when more records exist. If projection fails, the root gets a small failure-only request without tools rather than unbounded history. Automatic root compaction is declined.

`MEMORY.md` is at most 6,000 characters. The root reflects and rewrites it when useful; there is no separate extraction/consolidation service. A content revision and atomic replacement protect cooperating writers from stale overwrites. External editors can still race the final comparison and rename.

Job history is retrieved on demand through local keyword search over titles, briefs, and results. There is no vector store or automatic historical transcript scan.

Explicit forgetting rewrites the note, clears stale focus, and cuts earlier recent dialogue from personalization. Raw transcripts, job records, legacy saved facts, and backups remain. This is not secure erasure or semantic redaction of every historical mention.

## Jobs, wakes, and delivery

### Jobs

Job creation atomically records the job, its native background ownership task, and its worker conversation. Stable caller keys deduplicate starts; stable request IDs deduplicate worker submissions. Jobs expose `running`, `completed`, `failed`, and `cancelled` states.

The defaults are four active jobs and a fifteen-minute absolute deadline. Downtime counts toward the deadline. Root cancellation does not cancel background work; explicit job cancellation does. A report retains the originating address even when later inputs arrive elsewhere.

### Wakes

A wake is a one-shot native task waiting for an absolute timestamp. Firing and inbox admission happen in one commit. Overdue wakes fire once when the process resumes; repeated keys do not create another event. Explicit cancellation cannot retract a wake already admitted to the root.

Wakes are silent by default. The root can use `notify` if attention is needed, or schedule a wake that delivers its final answer. The root chooses any repetition and reflection policy; no fixed heartbeat is imposed. Extensions can also use the [wake event hook](docs/EXTENSIONS.md#wake-hooks).

A commitment due date does not create a wake. No wakes execute while the host is stopped, and the installer does not install a daemon.

### Guarantees and limits

| Mechanism                     | What it provides                                           | What it does not provide                                        |
| ----------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Stable ingress/job/event keys | Internal admission deduplication across restart            | Deduplication when a caller invents a new key on each retry     |
| Native task checkpoints       | Restart from committed progress                            | Exactly-once arbitrary external effects                         |
| Durable reply task            | Retried delivery with a stable key                         | Exactly-once transport delivery without recipient deduplication |
| Safe/unsafe tool replay       | Unsafe interrupted tools are not blindly replayed          | Undo of effects completed before interruption                   |
| Approval record               | A decision bound to a call and address                     | Isolation from arbitrary trusted code                           |
| Extension activation recovery | Recover prior known-good code after interrupted activation | Undo of state migrations or external actions                    |

## State ownership

| Location           | Contents                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `japa.sqlite`      | Native transcripts/tasks/checkpoints plus jobs, commitments, approvals, wake records, delivery receipts, installation manifest, and legacy memory migration metadata |
| `MEMORY.md`        | Active personal memory; not a mirrored fact database                                                                                                                 |
| `settings.json`    | Provider/model choices and stable installation identity                                                                                                              |
| `credentials.json` | API keys or complete OAuth credentials, including refresh state                                                                                                      |
| `workspace/`       | Worker files and artifacts                                                                                                                                           |
| `extensions/`      | Immutable generated sources and executable bundles                                                                                                                   |

Telegram additionally keeps private bot/owner configuration and a polling checkpoint, and model providers may cache native catalogs. Settings responses never enter conversation ingress. Telegram acknowledges incoming updates only after admission completes; stable event IDs deduplicate a repeated admission. Telegram outbound messages are still at-least-once, including split replies. Telegram messages are not secret input fields: settings deletion is best-effort, not secure erasure.

Configuration and file memory are not transactional with SQLite. Settings and credentials are individually atomic files, not a two-file transaction. Credentials are local plaintext with owner-only file permissions, not an OS keychain.

## Self-extension and intentional scope

Installation is single-file TypeScript → typecheck → bundle → child probe/optional self-test → pending manifest → activation → good manifest. The child process is a compatibility check, not a sandbox. Interrupted activation can be quarantined on restart; runtime errors do not automatically roll back an extension.

Generated extensions may add worker tools, sections, hooks, and wrappers. Adapter/lifecycle changes require restart and normal host composition. The generated-code path rejects custom durable task definitions. [Extension documentation](docs/EXTENSIONS.md) describes these boundaries and limits.

Apart from bundled channels and native model providers, app integrations are intentionally not bundled: the assistant builds what its user needs. Web channels, voice, attachments, managed hosting, cron/timezone recurrence, vector memory, production multi-user isolation, billing, and comprehensive cost/retention policies are not implemented.

See [operations](docs/OPERATIONS.md) for recovery procedures and [contributing](CONTRIBUTING.md) for executable invariants and validation limits.
