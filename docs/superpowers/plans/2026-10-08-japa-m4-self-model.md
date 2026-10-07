# japa Milestone 4: Skills, Self-Model, Settings, Changes, Secrets (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the CoS a fuller picture of itself and of the user's setup:
- the full identity section and a generated capabilities section;
- skills, available both to the CoS and to workers;
- tools to read and change settings, with every change logged and undoable;
- a way to ask the user for a secret without the value ever entering the transcript.

Model API keys come from the secrets store.

**Architecture:** This milestone builds on M1–M3.
- **Settings:** one mutable `settings` object is shared by every kernel closure. `settings_set` validates the new value, writes `settings.json`, updates that object in place (so the change is live) and logs an entry in `japa.changes`.
- **Skills:** Markdown content loaded with M2's frontmatter parser. A `skills` section lists them, and `skill_read` loads a skill's body.
- **Secrets:** a pi-ai `CredentialStore` backed by the `secrets` adapter. Pending secret requests are kept in the root document `japa.secretRequests`, surfaces fulfil them, and the gateway shows them as masked prompts.

**Spec:** `docs/superpowers/specs/2026-10-07-japa-design.md`. This plan covers §8, §9.1–§9.5, and the secret and credential parts of §4.2:
- provider keys from the secrets store;
- `SurfaceContext.secrets`;
- "extensions read only the secret names their manifest lists".

It also covers two carry-overs:
- the CoS environment must deny reads of the secrets store;
- live settings.

## Global Constraints

- All constraints from M1–M3 still apply. **Prime directive from the user:** don't overcomplicate. Write minimal code and no code for its own sake.
- Tests use the faux provider and never touch the network.
- A changes-log entry has the shape `{ id, at, title, howToUse, undo: { commits: string[], configOps?: ConfigOp[] } }`, where `ConfigOp = { path: string; before?: JsonValue }` (`before` is absent when the path did not exist). `commits` stays `[]` until M5.
- Secret names match `/^[a-z0-9][a-z0-9._-]*$/`. A provider's API key is stored as the secret `<provider>.apiKey`, using the spec's own example name.
- A secret value must never appear in any stored entry, document, tool result or log.

## Rulings (binding)

- **Live settings work by mutating in place.** The kernel holds one `Settings` object, and all code reads fields when it uses them. Changes made with `settings_set` take effect immediately. Edits made by hand to `settings.json` take effect on restart. `storage` and `secrets` are boot-phase keys and always need a restart. *If wrong:* hand edits need a restart.
- **Settings are validated with pi-ai.** Use pi-ai's `validateToolArguments`, wrapping the schema as a tool's parameters. This avoids adding a direct dependency on `typebox`. *If wrong:* awkward error text.
- **Only API-key credentials are supported.** The credential store handles `api_key` credentials only. OAuth is out of scope. *If wrong:* no OAuth providers in v1.
- **Reads of the secrets store are denied by path.** The CoS read-only environment refuses reads under `<home>/secrets` and under `settings.secrets.dir` when that is set. Job environments are not restricted: worker safety is the same as the CoS's in v1 (spec §5.3). *If wrong:* a worker with `read` could read secret files.

## Review Focus

1. **Secret values never leak.** After a secret request is fulfilled, the value appears in no conversation entry, no document, no event and no gateway message apart from the client's own outgoing `secret` message. Test in Task 5.
2. **Invalid settings are rejected.** A `settings_set` that fails validation changes nothing: the file, the in-memory object and the changes log are all left as they were. Test in Task 1.
3. **Undo restores the exact previous state.** `change_undo` on a settings change restores the old value, or removes the key if it did not exist before. Test in Task 1.
4. **The CoS cannot read secrets.** The root's `read` of a file under the secrets directory fails. Test in Task 4.
5. **Capabilities stay truthful.** The capabilities section lists exactly the installed extensions, the worker profiles and the configured models. Test in Task 3.

---

## File Structure

```
src/kernel/settings.ts           + settingsSchema, setPath/getPath, saveSettings
src/kernel/changes.ts            ChangesDoc ("japa.changes"), logChange(), undoConfigOps()
src/kernel/settings-tools.ts     settings_get / settings_set / changes_list / change_undo
src/kernel/skills.ts             Skill, loadSkills(dirs), skillsExtension()
src/kernel/identity.md           full identity text (§9.1)
src/kernel/capabilities.ts       capabilities(...) -> string
src/kernel/credentials.ts        secretsCredentialStore(store)
src/kernel/secret-requests.ts    SecretRequestsDoc, secret_request tool, fulfil()
src/kernel/env.ts                readOnly(env, deny: string[])
src/kernel/contracts.ts          KernelContext.secret/settings; SurfaceContext.secrets
src/kernel/extension.ts          manifest `settings` schema
skills/                          (empty dir kept with .gitkeep; default skills come in M6)
extensions/gateway/*             secret prompts
```

---

### Task 1: Live settings, settings tools, changes log

**Files:**
- Modify: `src/kernel/settings.ts`, `src/kernel/extension.ts`, `src/kernel/boot.ts`, `src/kernel/cos.ts`, `src/kernel/contracts.ts`
- Create: `src/kernel/changes.ts`, `src/kernel/settings-tools.ts`
- Test: `test/settings-tools.test.ts`

**Interfaces:**
- **Manifest.** `JapaExtension.settings?: TSchema` holds a TypeBox schema for `settings.extensions.<name>`.
- **Paths.** `getPath(obj, path)` and `setPath(obj, path, value | undefined)` take dotted paths. Setting `undefined` deletes the key.
- **Saving.** `saveSettings(home, settings)` writes the *user's* `settings.json`, meaning the keys the user set, not the merged defaults. Keep a separate `user` object alongside the merged one: `loadSettings` returns both, or the kernel re-reads the file. Pick the simplest approach.
- **Schema.** `settingsSchema` is a TypeBox schema for the kernel keys:
  - `models.*`: `{ provider: string, modelId: string }`
  - `jobs.maxConcurrent`: integer ≥ 1
  - `context.*`: numbers > 0
  - `memory.*`: integers ≥ 1
  - `storage` and `secrets`: objects with `adapter: string`
  - `extensions`: a record of objects

  `extensions.<name>` values are validated against that extension's `settings` schema when it has one.
- **Changes doc.** `ChangesDoc` is the root doc `japa.changes`: `{ nextId: number; changes: Change[] }`.
- **`logChange(tx, { title, howToUse, undo })`** appends an entry and returns its id. It is exported from `src/sdk.ts` for M6's `schedule`.
- **CoS tools**, added to `japa-cos`:
  - `settings_get({ path? })` returns the merged settings, or the value at `path`, as pretty JSON.
  - `settings_set({ path, value, title?, howToUse? })` does the following:
    1. Validates the whole merged result with the new value applied. If that fails, it returns `Not changed: <error>` and changes nothing.
    2. Otherwise it writes the user file, mutates the live object in place, and logs `{ title: title ?? "Set <path>", howToUse: howToUse ?? "", undo: { commits: [], configOps: [{ path, before }] } }`. `before` is the previous *user* value.
    3. It replies `Set <path>. (change <id>)`, and appends ` Takes effect after a restart.` when `path` starts with `storage` or `secrets`.
  - `changes_list()` gives one line per change, newest first: `<id> <ISO date> <title>`, or `No changes yet.`
  - `change_undo({ id })` applies the change's `configOps` in reverse order: restore `before`, or delete the key when `before` is absent. It validates the result first. It then removes the entry from the log and replies `Undid: <title>`. If the change has `commits`, it replies `Can't undo that yet.` (M5 handles those.)
- **Live use.** The CoS cap hook, the consolidation trigger and the job concurrency check already read `settings.*` when they run. Confirm they read the shared object and don't copy it, and fix any that copy.
- **`KernelContext.settings(): JsonObject`** returns the live `settings.extensions[<extension>] ?? {}`.

- [ ] **Step 1: Write failing tests:**
  - `settings_set("jobs.maxConcurrent", 2)`:
    - updates `settings.json`;
    - updates the live value, so a third job is queued right away;
    - logs a change.
  - `settings_set("jobs.maxConcurrent", 0)` replies `Not changed: …`, and the file, the live value and the log are all unchanged.
  - Undo works in both directions:
    - Undoing a set of a key that was absent removes it from the file, and the default applies again.
    - Undoing a set of a key that existed restores the old value.
  - `extensions.<x>.limit` is validated against a test extension's schema.
  - A test extension's `settings()` reflects a change immediately.
  - The `storage.file` reply mentions the restart.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): live settings, settings tools, changes log`

---

### Task 2: Skills

**Files:**
- Create: `src/kernel/skills.ts`, `skills/.gitkeep`
- Modify: `src/kernel/boot.ts`, `src/kernel/jobs/cos.ts` (job selection + `JobDoc.skills`), `src/kernel/jobs/state.ts`, `src/kernel/workers.ts` (`skills` now kept)
- Test: `test/skills.test.ts`

**Interfaces:**
- **`Skill`** is `{ name; description; dir; file /* SKILL.md path */ }`.
- **`loadSkills(dirs)`** returns `{ skills: Map<string, Skill>; errors }`:
  - Each skill is a `<dir>/<name>/SKILL.md` with `name` and `description` frontmatter.
  - Later dirs override earlier ones.
  - A bad skill is reported as `skill:<dir name>` and skipped.
- **Directories, in order:**
  1. packaged `skills/`
  2. each loaded extension's `<extensionDir>/skills/`, for extensions whose source dir is known (the loader knows each module's path)
  3. `<home>/skills/`
- **`skillsExtension(skills)`** returns the Pi Durable extension `japa-skills`. It is selected by the root (add it to the host default list) and by every job (add it to `agentOf`). It contains:
  - **Section `skills`:** lists `- <name>: <description>` and ends with "Load one with skill_read when it applies." It is omitted when there are no skills.
    - The root sees all skills.
    - A job whose `JobDoc.skills` is set sees only those skills. `JobDoc` gains `skills?: string[]`, written at `job_start` from the profile.
  - **`skill_read({ name, file? })`** returns the SKILL.md body, without its frontmatter, or the text of `file`, a path relative to the skill dir.
    - `file` must stay inside the skill dir. If it doesn't, the reply is `Not part of skill <name>.`
    - An unknown skill gets `No skill "<name>". Skills: <names>.`
    - Skills are read on the kernel side with `fs`, not through the conversation's environment, so the read-only CoS can read them.
- **Profiles.** A profile's `skills` must name known skills. This joins Task 3 of M2's profile check; unknown names are reported as `worker:<name>`.

- [ ] **Step 1: Write failing tests:**
  - Discovery: a packaged skill is overridden by a home skill.
  - An extension-bundled skill is found.
  - A bad skill is reported.
  - The root's request has a skills section listing both.
  - A job with profile `skills: [a]` sees only `a`.
  - `skill_read` returns the body and a reference file.
  - `skill_read` refuses `../x`.
  - A profile naming an unknown skill is reported.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): skills`

---

### Task 3: Identity and capabilities

**Files:**
- Modify: `src/kernel/identity.md`, `src/kernel/cos.ts`, `src/kernel/boot.ts`
- Create: `src/kernel/capabilities.ts`
- Test: `test/capabilities.test.ts`

**Interfaces:**
- **`identity.md`** holds the full static text of spec §9.1 in plain second person. Its parts:
  - **Role:** the single point of contact who keeps its own context lean. It does quick things itself (one or two tool calls) and delegates multi-step, long-running or heavy work, plus anything that writes files or runs commands, to a job with `job_start`.
  - **How japa works:** one short paragraph each on the thread, jobs and workers, memory, skills, extensions and contracts, triggers, and surfaces.
  - **The mechanism ladder:** as a table or a list, with the test that "if existing tools plus written instructions can do it, it's content".
  - **The four UX rules:** verbatim in substance, including the report format.
  - **A short note on memory:** save lasting facts with `memory_remember` when the user asks or when something is clearly worth keeping; you may add "(noted: …)". Settings changes go through `settings_set`, and "undo that" goes through `change_undo`. Secrets go through `secret_request`; never ask for a secret in chat.
  - Keep it under about 700 words.
- **`capabilities({ extensions, contracts, profiles, settings, models })`** returns this text:

  ```
  Extensions:
  - <name>: <summary>          (one per loaded extension, load order)
  Workers:
  - <name>: <description>
  Models: cos <p/m>, worker <p/m or "same as cos">, consolidation <p/m or "same as cos">
  Surfaces: <surface names>
  Contracts:
  - <name>: <first sentence of docs>
  ```

  Active schedules are left out until M6 adds them.
- **Section `capabilities`:** in `japa-cos`, between `identity` and `about-you`. It renders the current value of a variable that the kernel recomputes at boot and after any `settings_set` or `change_undo`. M5 will also recompute it on install and reload.

- [ ] **Step 1: Write failing tests:**
  - **Format:** `capabilities()` on fixture inputs gives the exact text, including "same as cos".
  - **Section order:** the root's system sections appear in the order identity, capabilities, about-you. Check the faux `role: "system"` message text order.
  - **Contents:** the capabilities section names a test extension's summary and the `general` worker.
  - **Model change:** after `settings_set("models.worker", …)`, the next request's capabilities show the new worker model.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): identity and capabilities`

---

### Task 4: Secret access and model credentials

**Files:**
- Create: `src/kernel/credentials.ts`
- Modify: `src/kernel/env.ts`, `src/kernel/boot.ts`, `src/kernel/contracts.ts`, `extensions/providers/index.ts` (summary text: "with API keys from the secrets store or environment variables")
- Test: `test/secrets-access.test.ts`, `test/env.test.ts`

**Interfaces:**
- **`secretsCredentialStore(store: SecretsStore): CredentialStore`.**
  - `read(p)` returns `{ type: "api_key", key }` when the secret `<p>.apiKey` exists, and `undefined` otherwise.
  - `list()` returns `{ providerId, type: "api_key" }` for each `*.apiKey` name.
  - `modify(p, fn)` applies `fn` to the current credential. An `api_key` result is stored. Any other type throws `Only API keys are supported`.
  - `delete(p)` removes the secret.
  - Check the exact `CredentialStore` interface and option arguments in pi-ai's `dist/auth/credential-store.d.ts`.
  - Boot creates `createModels({ credentials: secretsCredentialStore(secrets) })` and keeps the opened secrets store. The M1 deferred note about "opened secrets store not kept" is resolved here.
- **`KernelContext.secret(name): Promise<string | undefined>`** reads the store, but only for names in the extension's manifest `secrets` list. Any other name throws `Extension <ext> did not declare secret "<name>"`.
- **`readOnly(env, deny: string[])`.**
  - Every read method of `ExecutionEnv` that takes a path refuses a path inside any `deny` dir, returning `permission_denied` with the message `Secrets are not readable here.`
  - Paths are resolved against `env.cwd`.
  - Enumerate the methods from the pi-durable `ExecutionEnv` type.
  - The dispatcher passes `[join(home, "secrets"), settings.secrets.dir (if set, ~ expanded)]`.

- [ ] **Step 1: Write failing tests:**
  - **Credential store:** a secret `faux.apiKey`, or the test provider's id, is returned by `read`. `modify` with an OAuth credential throws.
  - **Models through the store:** with a pi-ai provider that requires an API key, `models` resolves the key from the store. Use the faux provider if it can require auth; otherwise unit-test the store with `createModels` and assert on `models` auth status for a built-in provider (`hasConfiguredAuth` or similar). No network.
  - **Declared secrets:** `secret()` returns a declared secret and throws for an undeclared one.
  - **Read-only env:**
    - a read under `secrets/` is denied;
    - a sibling path is allowed;
    - a write is still denied with `READ_ONLY_MESSAGE`.
  - **End-to-end:** the root's `read` tool on `<home>/secrets/x` returns the denial in the tool-result entry.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(kernel): secret access and model credentials`

---

### Task 5: Secret requests

**Files:**
- Create: `src/kernel/secret-requests.ts`
- Modify: `src/kernel/cos.ts`, `src/kernel/boot.ts`, `src/kernel/contracts.ts`, `src/sdk.ts`, `extensions/gateway/protocol.ts`, `extensions/gateway/index.ts`, `extensions/gateway/chat.ts`
- Test: `test/secret-requests.test.ts`, `test/gateway.test.ts`

**Interfaces:**
- **`SecretRequestsDoc`** is the root doc `japa.secretRequests`: `{ nextId: number; pending: SecretRequest[] }`, where `SecretRequest = { id: string; name: string; why: string; at: number }`.
- **`secret_request({ name, why })`** is a CoS tool in `japa-cos`. It behaves as follows:
  - An invalid name gets `Invalid secret name.`
  - If a request for `name` is already pending, it replies `Already asked for <name>.`
  - Otherwise it adds the request and replies `Asked the user for <name>. You'll be told when it's provided.`
- **`SurfaceContext.secrets`:**
  - `pending(listener): Promise<{ stop }>` sends the current list first, then every change, through a `watchDoc`, the same way `jobs` does.
  - `fulfil(requestId, value): Promise<void>`:
    1. Throws `No pending request <id>` for an unknown id.
    2. Calls `secrets.set(name, value)`.
    3. Removes the request in one commit.
    4. Posts `[secret <name> provided]` to the root with requestId `secret:<requestId>`.
  - The value is never written anywhere else.
- **Gateway:**
  - The server sends `{ type: "secrets", pending }` on attach and on every change.
  - The client message `{ type: "secret", requestId, value }` calls `fulfil`. Any error comes back as `{ type: "error" }` without the value.
- **TUI:**
  - While at least one request is pending, the editor area is replaced by a masked input. Use pi-tui `Input`, with typed characters rendered as `•`; subclass or wrap its render if `Input` has no mask option.
  - The prompt reads `<why> — enter <name> (hidden):`.
  - Enter sends the `secret` message, and Esc dismisses the prompt until the next change.
  - The masked value must never be added to the transcript lines.

- [ ] **Step 1: Write failing tests:**
  - **Kernel flow:**
    1. The CoS calls `secret_request("svc.token", "to read your calendar")`.
    2. `pending` lists it.
    3. `fulfil(id, "s3cr3t")` stores it in the secrets adapter.
    4. The root receives `[secret svc.token provided]` once, including when `fulfil` is called twice with the same id. The second call throws `No pending request`.
    5. `JSON.stringify` of all root entries, all docs read through the harness (`JobsDoc`, `MemoryDoc`, `ChangesDoc`, `SecretRequestsDoc`) and all events seen by a `root.events` listener contains no `s3cr3t`.
  - **Gateway:** a client receives `secrets` with the request, sends `secret`, then receives an empty `secrets` list.
- [ ] **Step 2–4:** RED, implement, GREEN. Check by hand that `japa chat` shows the masked prompt. You can trigger a request with a test-only extension or by calling `fulfil` in a quick script; no model is needed.
- [ ] **Step 5: Commit** `feat(kernel): secret requests`
