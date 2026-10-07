# Operations

Japa is a single-host-process assistant on Pi Durable 1.0.4, with terminal and
private Telegram channels, not a managed hosting service. Start with [README](../README.md); see [architecture](../ARCHITECTURE.md),
[contributing](../CONTRIBUTING.md), and [extensions](EXTENSIONS.md) for design,
development, and extension authoring.

## Install, run, and choose a home

Requires Node.js 24+ and npm. Run the installer from a checkout:

```sh
./install.sh --no-start
"$HOME/.local/bin/japa"
```

Without `--no-start`, installation launches only with terminal input and output.
No sudo, global npm install, daemon, or service setup is used. Add the launcher to PATH.

| Setting                | Default / precedence                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| Application copy       | `JAPA_INSTALL_DIR`, otherwise `${XDG_DATA_HOME:-$HOME/.local/share}/japa`    |
| Launcher directory     | `JAPA_BIN_DIR`, otherwise `$HOME/.local/bin`                                 |
| Installed runtime home | Nonempty `JAPA_HOME`, otherwise `${XDG_STATE_HOME:-$HOME/.local/state}/japa` |
| Source runtime home    | `JAPA_HOME`, otherwise `./.japa`, relative to the working directory          |

The launcher remembers the install-time app location; changing `JAPA_INSTALL_DIR`
later does not relocate it. Keep application files separate from runtime state.

Source runs use the checkout and its pinned dependencies:

```sh
npm ci
JAPA_HOME="$HOME/.japa" npm start
# For an installed launcher using that same home instead:
# JAPA_HOME="$HOME/.japa" japa
```

Do not run both against the same home concurrently. Use an absolute, nonempty
`JAPA_HOME`; do not mistake a new empty home for lost history.

## Login and model settings

With no usable configuration, startup opens setup in the selected channel before
the Host. All native pi-ai providers are registered; login choices reflect each
provider's actual OAuth, API-key, or ambient-credential capabilities. Usable
saved/environment configuration can bypass prompts. Terminal prompts need a TTY;
Telegram renders the same shared flow in its configured owner's private chat.
OAuth may require a browser callback, device authorization, or manual callback/code
entry. Native loopback-only flows on a remote host may need SSH port forwarding;
registering every provider does not make every login method headless.

- `/settings` closes the running Host, opens settings under the same home lock,
  then resumes durable work when a usable configuration is returned.
- `japa --setup` or `npm start -- --setup` opens settings before startup.
- First-run setup chooses defaults. Settings offers main/worker model selection,
  login, logout, Save, and Cancel. Cancel retains a usable previous configuration;
  it cannot start an unconfigured installation.
- Saving logout when the selected roles no longer have usable credentials leaves
  the assistant disconnected. The terminal exits; Telegram keeps `/settings`
  reachable without opening the Host or resuming work. Logout is local, not upstream revocation;
  environment credentials still apply. Existing workers keep their chosen model,
  so removing its credentials can fail those jobs.

Model-selection precedence is independent of credential presence:

1. `JAPA_MODEL=provider/model` and `JAPA_WORKER_MODEL=provider/model` override their
   respective roles for this run, without replacing saved selections.
2. Otherwise saved roles in `settings.json` win, even if another provider's API
   key is present in the environment.
3. Without saved roles or overrides, OpenAI defaults to `gpt-5.4` for the main
   model and `gpt-5.4-mini` for workers. Anthropic defaults to `claude-sonnet-4-6`
   for both. `OPENAI_API_KEY` wins the initial provider choice when both API keys
   exist; Anthropic environment credentials select Anthropic otherwise, including
   `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN`.

The native providers use stored OAuth/API-key credentials ahead of ambient
credentials; a failed stored OAuth refresh does not silently switch to an
environment key. Native provider environment credentials support unattended use;
set valid `JAPA_MODEL` / `JAPA_WORKER_MODEL` refs when the desired provider is not
the default. Use private environment injection rather than pasting keys into shell
history. Dynamic provider catalogs are cached, and refresh targets selected
providers rather than probing every provider indiscriminately.

`settings.json` stores selections/installation identity; `credentials.json` stores
credentials separately. Both are atomically replaced with mode `0600`, not as one
transaction. Credentials are **plaintext**, not encrypted or in a keychain. OAuth
refresh uses Pi's credential-store protocol. Local credential availability does not
prove subscription entitlement, quota, network access, or a successful live request.

**Never put secrets in ordinary assistant messages, worker briefs, MEMORY.md, or
support reports.** Setup input is routed separately and never enters model history;
trusted workers can nevertheless read files and environment variables accessible
to the process. Telegram setup has the transport privacy limits below.

## Telegram

The bundled channel supports **one explicitly configured private owner**, text,
replies, approvals, and the shared provider setup. It does not accept groups,
unknown senders, voice, or attachments. There is no first-sender auto-pairing.

1. Obtain a bot token from BotFather and send `/start` to that bot from the intended
   owner's account. Know that account's positive numeric private chat ID.
2. Privately create `<JAPA_HOME>/telegram.json` with mode `0600` inside an
   owner-only home. Its contents are:

   ```json
   { "token": "<BotFather token>", "chatId": "<positive owner chat ID>" }
   ```

3. Run `japa --telegram`, or `npm start -- --telegram` from a source checkout.
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` can override the file via private
   environment injection. Do not embed real tokens in command lines or reports.

`/settings` pauses the durable Host and opens the same provider/model setup as the
terminal. Reply to the numbered prompts; `/default` selects the default and
`/cancel` cancels. Settings answers and late replies to marked settings prompts
never enter ordinary ingress. Sensitive replies are deleted best-effort, but
**Telegram receives them and may retain copies**. This is not hidden terminal input
or end-to-end encrypted secret chat. Use terminal setup instead if that transport
risk is unacceptable. Native provider login prerequisites still apply.

With no model connected, the bot stays available for `/settings`, but no durable
assistant work resumes. `/start` and `/help` describe supported commands; `/approve`
and `/deny` resolve address-bound approvals. Stop the process/service for shutdown;
remote `/exit` is not a service-management command.

Only one poller may use a bot token. Japa checks for an existing webhook and refuses
to replace it silently; deliberately remove or migrate the old webhook before
switching to polling. Keep the previous process stopped before starting a
replacement. No inbound port or public web server is needed.

Incoming Telegram offsets are saved after durable admission, and stable update IDs
handle repeat admissions after a crash. Keep the polling checkpoint with the rest
of the home. Outgoing delivery is **at-least-once**; long replies are split and can
be partially repeated after a failure. Do not delete queued Telegram updates to
make a migration appear clean. Telegram retains unconsumed updates for at most
24 hours ([Bot API](https://core.telegram.org/bots/api#getupdates)).

### Optional systemd supervision

The installer still does not install a daemon. [The example unit](../examples/japa.service)
shows an explicit operator-managed deployment under a dedicated `japa` account.
Create that account, install as it, configure its private home, and adjust the
absolute paths before installing the unit. Never run two copies of the bot.

```sh
sudo install -m 0644 examples/japa.service /etc/systemd/system/japa.service
sudo systemctl daemon-reload
sudo systemctl enable --now japa.service
sudo systemctl status japa.service
```

The example is not a sandbox or managed hosting product. It needs Node.js 24+ on
its PATH and persistent writable state. Back up and stop the service before
upgrades. A rotated bot token requires restarting the process to reload channel
configuration; rotate tokens exposed in chat, logs, or command history.

## Lifecycle and scheduling

The CLI's single-home lock covers SQLite and credential refresh; only one process
may own the home. Library users must supply equivalent coordination. After a crash,
let stale-lock recovery retry; do not delete a potentially live process's lock.

Use terminal `/exit`, Ctrl+C, or SIGTERM for orderly shutdown and wait for process exit
before maintenance. A crash/SIGKILL is not a clean backup boundary. EOF can wait
for admitted work; use `/exit` rather than assuming closing input stops immediately.
Pending native SQLite jobs and wakes resume on restart, not while stopped.
Jobs default to four active attempts and fifteen-minute deadlines; downtime
counts toward the deadline. Stopping is not the same as cancelling a job.

Wakes are one-shot absolute deadlines, with at most 32 pending. Overdue wakes are
admitted once on resume. They are silent unless notification is requested or the
assistant chooses to notify. A commitment's due date does not schedule a wake;
cancellation cannot retract an admitted wake. There is no cron recurrence, permanent
monitoring guarantee, or wake while stopped. A sleeping laptop is not always-on hosting.

Stop before reinstalling, then rerun `./install.sh` from the intended checkout.
The installer retains the previous managed app, leaves state alone, and refuses
unmanaged directories/unrelated launchers. This is not a state backup or downgrade
guarantee. Back up before upgrades and retain matching code/dependencies.

## Offline backup and nondestructive restore

Back up the **whole home**, not only `japa.sqlite`:

- Database plus any `japa.sqlite-wal`, `japa.sqlite-shm`, journal, or other sidecars.
  Never discard a WAL to make a copy look tidy.
- `workspace/`, including artifacts and hidden files.
- `extensions/` sources and bundles **together with** their manifest/replay
  receipts in the database (`japa.extensions`), not a separate manifest JSON.
- `MEMORY.md`, `settings.json`, `credentials.json`, Telegram configuration/checkpoint,
  native model catalog caches, and any other home files.

Stop Japa, confirm no process or external writer uses the home, and keep it stopped.
After a crash preserve untouched files first; do not selectively copy or manually
repair SQLite sidecars. This is an offline copy, not a live SQLite backup facility.

In a shell, replace the home path with the actual absolute path:

```sh
home="/absolute/path/to/japa-home"
umask 077
backup=$(mktemp -d "$HOME/japa-backup.XXXXXX") &&
cp -a -- "$home" "$backup/home" &&
printf 'Backup: %s\n' "$backup"
```

Check copy success before restarting. Back up outside the home and retain a
protected off-device copy for disk failure. Backups contain plaintext secrets and
history; Japa does not encrypt them. External files, external symlink targets,
environment-only credentials, and upstream services need separate recovery plans.

Record the app location, checkout revision, dependency lockfile, and Node version.
Bundles can reference absolute runtime imports; workers retain working-directory
paths. Prefer the same absolute home/app paths and matching runtime on restore.
A relocated home is not a guaranteed portable export.

For an existing home, stop Japa again and confirm exclusive offline access. Stage
an inspected backup in a fresh sibling directory, without changing the live home:

```sh
home="/absolute/path/to/japa-home"
backup="/absolute/path/to/japa-backup.XXXXXX"
umask 077
stage=$(mktemp -d "$(dirname -- "$home")/japa-restore.XXXXXX") &&
cp -a -- "$backup/home" "$stage/home"
```

Verify completeness, ownership, permissions, and sidecars. Do not start Japa against
the staged copy to inspect it: startup resumes work and may perform external actions.
After verification, retain the current home intact in a fresh rollback directory:

```sh
rollback=$(mktemp -d "$(dirname -- "$home")/japa-before-restore.XXXXXX") &&
mv -- "$home" "$rollback/home" &&
mv -- "$stage/home" "$home" &&
printf 'Previous home retained: %s\n' "$rollback/home"
```

Proceed only after each step succeeds. If placement fails, remain offline; inspect
retained directories without merging/overwriting them. Keep both old copies until verified.

**Before restarting:** review what may replay and reconcile external systems.
Rollback can reintroduce pending jobs, approvals, wakes, messages, and old OAuth
refresh tokens; re-login may be necessary. Never run original and restored copies
in parallel against the same external accounts. Delivery is at-least-once unless
a channel deduplicates keys. Shell commands and external effects are not made
exactly-once, nor undone by restoring files. Internal deduplication cannot protect
against effects whose receipts were rolled back. Safe mode is not an offline or
read-only restore verifier.

## Safe mode and extension recovery

Start with `japa --safe` or `npm start -- --safe` to skip generated-extension
restoration. Packaged tools, model calls, jobs, wakes, filesystem/shell access,
and the worker extension guide/catalog/install tools remain available. Workers
can still install new code in safe mode; durable work still resumes.

For a suspected bad extension, stop and back up. Use safe mode in a trusted/isolated
environment; ask a worker to inspect `extension_catalog` diagnostics. `active: null`
means not loaded, not uninstalled. See [extensions](EXTENSIONS.md) for repair details.

Normal startup quarantines interrupted activation and tries previous known-good
code when available. A good revision that fails startup loading is quarantined with
diagnostics, not guaranteed fallback. Safe mode skips this recovery pass; pending
installs can block installation until normal-start recovery. Runtime failures do
**not** trigger automatic rollback. Recovery never reverses migrations/external effects.

Identical accepted source returns a receipt, not reactivation/rollback; quarantined
content must be edited before retrying. Do not edit hashed bundles or prune receipts
to force activation. Limits are 32 extensions and 16 revisions each; reaching them
requires maintenance, not silent cleanup. Child probes run trusted code, not a sandbox.

## Memory maintenance

`MEMORY.md` is a reflective note limited to 6,000 characters. Oversize files/rewrites
fail without truncation. Stop Japa, preserve a copy, compact deliberately, and restart.
For revision conflicts, reread and reconcile before retrying; never resubmit stale
text blindly. Atomic replacement and in-process serialization cannot prevent every
external-editor race, so prefer offline manual editing.

Legacy `japa.memory` records migrate once when no file exists. Any existing file,
even empty, wins. If legacy import exceeds the limit, originals remain in SQLite;
create a reviewed note within the limit, or an intentionally empty file to skip
import, and restart. After migration, a missing file does not reimport old facts.
Forgetting via the memory tool can clear stale conversational context; manual
editing alone does not do that. Neither is secure erasure: transcripts, jobs,
legacy records, and backups remain. There is no comprehensive deletion facility.

## Troubleshooting

| Symptom                                   | Check / next step                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `japa` not found / wrong home             | Check launcher PATH and explicit `JAPA_HOME`; installed and source defaults differ.                                                                          |
| Lock acquisition fails                    | Confirm another process is not running; wait for stale-lock recovery after a crash. Never bypass a live owner.                                               |
| Setup needs a terminal                    | Run interactively, use a configured Telegram channel, or supply usable provider credentials and valid role selections.                                       |
| Telegram rejects token / polling conflict | Validate the bot token privately; stop other pollers and check for an existing webhook. Never paste tokens into logs or support reports.                     |
| Auth/model request fails                  | Check `/settings`, role environment overrides, provider entitlement/quota, and network access. A saved login is not a live validation.                       |
| Invalid settings/credentials JSON         | Startup refuses to overwrite it. Preserve the files offline and repair privately or restore a coherent backup; never paste credential contents into reports. |
| Wake did not notify / job expired         | Confirm host uptime, wake status/notification choice, and elapsed job deadline including downtime.                                                           |
| Memory startup error                      | Compact an oversize note or follow the explicit legacy-import guidance above; retain originals.                                                              |
| Extension missing or install blocked      | Inspect catalog status/diagnostics in safe mode; pending recovery requires normal startup. Retain bundles and database receipts together.                    |

## Trust boundary and unsupported production features

Workers/extensions have full process privileges. Workspace is not confinement;
policy/approvals are safeguards, not isolation. Use a dedicated account/container/VM
with restricted mounts, network, and credentials. Probes do not make untrusted code safe.

There is no production multitenancy, tenant authentication/isolation, managed
background hosting, distributed failover, comprehensive cost budgeting, automatic
retention/compaction, or guaranteed scheduling SLA. Pi Durable is experimental.
Treat this as a trusted single-user backend, not an internet-facing service.
