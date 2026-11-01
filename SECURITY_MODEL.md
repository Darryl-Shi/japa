# japa threat model

Personal chief-of-staff agent daemon (Node 24, TypeScript, ESM). Contract: `docs/spec.md`; product docs: `README.md`. Drafted from the code and the operator's answers; keep it current when trust boundaries change.

## Deployment
- **Native**: daemon runs as the operator's user (systemd user service), data in `~/.japa`, jobs in bubblewrap, desktop on the host's Docker.
- **Docker hosting**: one Sysbox system container per named instance (`install.sh`, `docker/Dockerfile`), never `--privileged`, never the host docker.sock; per-instance volumes and bridge network; noVNC published on `127.0.0.1:<port>`, web UI on `127.0.0.1` by default or `--webui-bind <addr>`/`0.0.0.0`.
- No TLS anywhere; web UI is plain HTTP.

## Components
| Component | Code | Trust side |
|---|---|---|
| **Web UI** | `extensions/webui/` (server.ts, auth.ts, users.ts, files.ts, settings.ts, flows.ts, app/), `src/cli/webui-users.ts` | Network-facing HTTP surface |
| **Messaging** | `extensions/telegram/`, `extensions/gateway/` (japa.sock), `src/kernel/messaging/` | Telegram internet surface; local socket |
| **Kernel & CoS** | `src/kernel/` (boot, cos, admin, settings, secrets/credentials, send-file, files, loader, extension, changes, safety, workspace), `src/sdk.ts` | Daemon process holding all secrets |
| **Jobs sandbox** | `src/kernel/jobs/`, `src/kernel/sandbox/` (bwrap.ts, env-server.ts, remote-env.ts) | Boundary between untrusted agent work and the daemon |
| **Integrations** | `extensions/google/`, `extensions/web/`, `extensions/brave/`, `extensions/parallel/`, `extensions/providers/`, `extensions/schedule/`, `extensions/file-secrets/`, `extensions/local-env/`, `extensions/sqlite/` | Outbound to third parties; ingest untrusted content |
| **Desktop** | `extensions/desktop/` (container.ts, Dockerfile, browser.ts, computer.ts), web UI `desktopProxy` | Docker container + noVNC |
| **Installer & hosting** | `install.sh`, `docker/`, `src/cli/` (setup, service, update, rollback) | Host / Sysbox boundary |

## Trust boundaries and entry points
1. **Web UI HTTP** (`127.0.0.1:7337` default; may be bound to LAN/Tailscale/`0.0.0.0`). Pre-auth: `/login`, static assets, Host/Origin checks, throttle. Post-auth: chat submit, multipart uploads (`/api/submit`), downloads (`/api/files/<id>`), Settings (full admin: secrets, providers, extensions, update/rollback), Desktop websocket proxy to noVNC.
2. **Telegram bot**: anyone on the internet can message it; only `extensions.telegram.owner` is served (`extensions/telegram/updates.ts`), others get their user id back.
3. **Local socket** `<home>/japa.sock` (`japa chat`): any process as the operator's user.
4. **Untrusted content ingested by the CoS/jobs**: web pages, search results, Gmail/Drive content, uploaded files (PDF text extraction in `src/kernel/messaging/attachments.ts`). Prompt injection can drive tool calls.
5. **Jobs → daemon/host**: bwrap sandbox (`src/kernel/sandbox/bwrap.ts`): own clone of `~/.japa` without secrets/`state.db`/socket; read-only install dir, launcher, systemd user units; Docker sockets masked; env stripped; `outbox/` writable; job changes under `extensions/` and `skills/` are `japa check`ed and merged live into `~/.japa` (code that then runs in the daemon with secrets).
6. **Docker tenant → host / other instances**: Sysbox container per tenant; tenants may have a shell in their own container.
7. **Desktop (noVNC)**: noVNC on `127.0.0.1:6080` (no password) natively; per-instance published loopback port.

## Assets
- Provider API keys / OAuth tokens (Anthropic etc.), Google OAuth tokens, Telegram bot token, `~/.japa/secrets/*` incl. `webui.session-key`.
- `~/.japa/webui/users.json` (scrypt hashes, session stamps).
- Operator's email, calendar, Drive, contacts, conversation transcript, memory, attachments.
- Code execution as the operator's host user (native) or inside the instance (Docker); the host itself and other tenants' instances.

## Attacker profiles (operator-confirmed as in scope)
- **Network attacker reaching the web UI** without credentials (LAN/VPN/`0.0.0.0` bind, DNS rebinding, CSRF from a malicious site in the operator's browser).
- **Stranger messaging the Telegram bot** (not the owner).
- **Sandboxed job escaping bwrap**: an agent job (possibly steered by injected content) reaching secrets, the daemon socket, Docker, systemd units, the install dir, or getting code live into the daemon outside the check/merge path.
- **Malicious Docker tenant** attacking the host or other instances (container escape, cross-instance network/volume access, launcher/installer abuse).
- **Prompt injection via web/email/files**: not selected as a top priority by the operator, but nothing is out of scope; treated at the scanner's severity.

## Trusted (operator-confirmed)
- All web UI users are the operator or people they fully trust: every signed-in user is effectively an admin. Findings that need a signed-in web UI user to attack another web UI user or the operator are not a privilege escalation in this model.
- The Telegram owner and anyone with a shell as the operator's user (native) are trusted.

## Existing controls
- Web UI: Host allowlist (anti DNS-rebinding), Origin check on state changes, strict CSP, no external requests, `HttpOnly; SameSite=Strict` HMAC session cookies tied to per-user stamps, scrypt hashes with dummy-hash timing defence, 10/min sign-in throttle, raw HTML in markdown not rendered, only `http(s)`/`mailto` links, downloads forced except images/PDFs, uploads served only from `<home>/attachments/`.
- Telegram: owner allowlist.
- Jobs: bwrap with masked Docker sockets, stripped env, read-only install/launcher/units, no setuid, private /tmp; `japa check` + three-way merge + undo for live changes; runtime auto-rollback on tool errors (`src/kernel/safety.ts`).
- Docker: Sysbox runtime, no `--privileged`, no host socket, per-instance network and volumes, loopback publishing by default.

## Out of scope / accepted risk
- Operator stated nothing is out of scope. Plain HTTP is documented (README) but not declared accepted risk.

## Open questions
- Is the web UI ever bound beyond loopback/Tailscale in practice (affects network-attacker reach)?
- Are third-party/workspace extensions installed by the operator considered trusted code?
