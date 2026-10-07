# Changelog

## Unreleased — v2 foundation

This describes the current implementation on `v2`, not a published npm release or a reconstruction of every development step. The package remains private.

### Added

- A single-process TypeScript host with eight replaceable adapters and explicit provider binding.
- Native Pi Durable 1.0.4 conversations, documents, background ownership, checkpoints, and SQLite recovery.
- A coordinator-only root with fresh workers, durable commitments, steering, cancellation, deadlines, and result review.
- Durable ingress/replies and stable internal admission keys; originating-address preservation.
- A bounded executive brief and completed-turn context reset, retaining raw history.
- Durable address-bound approvals and configurable allow/deny/ask tool policy.
- Trusted capability installation: typecheck, bundle, child probe, immutable artifacts, activation recovery, and safe startup.
- A local Bash installer, private app copy, terminal launcher, and first-run provider setup.
- Channel-rendered settings with native OpenAI/Anthropic login, API-key entry, credential refresh, model choices, and local logout.
- Searchable durable job history and one-shot wakes chosen by the chief of staff, including a public event hook and silent reflection.
- A compact `MEMORY.md` maintained through reflection, with atomic revision-checked rewrites and one-time migration of earlier saved facts.
- Deterministic runtime tests, SQLite reopen tests, actual `SIGKILL` recovery, and installation/authentication/terminal safeguards.
- Architecture, extension, operations, and contributor documentation; the original design proposal is archived.

### Contract changes from the initial working draft

- Channels must implement `SettingsUI`; provider setup does not pass through conversation ingress.
- Personal memory uses `read`/`rewrite` rather than a saved-fact catalog and bounded transcript search.
- Detailed recall comes from job search rather than automatic history expansion.
- Root tools now include `wake` and `notify`. A due date still does not implicitly schedule an action.

### Intentional boundaries

- No packaged app integrations, embedding service, fixed heartbeat, or second workflow engine.
- No background service, web/Telegram interface, voice, attachments, or production multi-user isolation.
- Trusted code has full process privileges; policy and probes are not sandboxes.
- External effects are not generally exactly-once, and activation recovery cannot undo external actions or state migrations.
- Forgetting is not secure deletion of transcripts, job records, or backups.
- Automated tests do not establish real-model task quality or live account entitlement.

See [architecture](ARCHITECTURE.md) and [operations](docs/OPERATIONS.md) for the precise guarantees and limitations.
