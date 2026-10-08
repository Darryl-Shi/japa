# japa — remove extension-defined contracts

Date: 2026-10-08
Status: Draft for review
Amends: `2026-10-07-japa-design.md` (the "main spec")

## 1. Purpose

Extensions can define their own contracts for other extensions to implement
(main spec §4.3). The only use is `web`'s `search-engine`, with one
implementation, `brave`, shipped inside `web` itself. Extensions are cheap to
write and to override, so this layer adds kernel code (contract loading,
dependency pruning, an activation slot, reload bookkeeping) and a hot-reload
wart (`web`'s engine map on `globalThis`) for no real use.

After this change, the contracts are exactly the kernel's core contracts. An
extension implements them; it cannot define new ones. Sharing between
extensions, if ever needed, goes through tools or the escape hatch.

## 2. Changes

### Kernel

- `src/kernel/extension.ts`: remove the manifest field `contracts`.
- `src/kernel/loader.ts`: remove `isContract`, the `contracts` field check,
  the duplicate-contract check, and the repeat-until-stable pruning of
  extensions that rely on a failed extension's contract. Every `provides` key
  must name a core contract; anything else stays the error
  `unknown contract "<name>"`.
- `src/kernel/runtime.ts`: `order()` returns `ACTIVATION_ORDER` as it is
  (no extension-defined slot). `reconcile` no longer adds or removes
  contracts. The `contracts` map input becomes the fixed core map.
- `src/kernel/contracts.ts`: `ACTIVATION_ORDER` loses its
  `/* extension-defined */` marker.
- `src/kernel/boot.ts`, `src/kernel/check.ts`: the contract map is built from
  `CORE_CONTRACTS` only.
- `src/kernel/capabilities.ts`: remove the "Contracts:" list and the
  `contracts` input. The core seams are fixed and named in the identity
  text's mechanism table.
- `src/sdk.ts`: stop exporting `Contract` and `CORE_CONTRACTS` (both stay in
  the kernel).

### `extensions/web`

- `web_search` calls Brave directly (`brave.ts` keeps the request code and
  `MissingKey`).
- Remove the `search-engine` contract, the `globalThis` engines map, the
  "No search engine" reply, and the `settings` schema (`engine`). The `setup`
  hook stays but captures `ctx.secret` (which the contract's `activate` used
  to supply) instead of settings.
- Manifest `docs`: drop the engine and contract sentences; keep the
  `web.brave.apiKey` secret.

A different engine is a new extension with its own tool (e.g. `exa_search`),
or a workspace `web` that overrides the packaged one by name.

### Content

- `src/kernel/identity.md`: remove "Extensions can also define new
  contracts."
- `skills/building-extensions/SKILL.md`: remove the "Defining a contract"
  section and the `contracts` manifest bullet.

### Main spec

- §4.3 removed; §4 intro and §4.4 no longer mention extension-defined
  contracts.
- §5.1 manifest example: remove `contracts: []` and `"search-engine": [...]`.
- §5.2 boot sequence: activation order without the extension-defined slot.
- §10.3 manifest checks: "every `provides` key names a core contract".
- §11.1 `web` row: "`web_fetch` (no key) and `web_search` (Brave; asks for its
  key with `secret_request` on first use)."
- §13 decisions summary: drop extension-defined contracts.

Unaffected: the core contract list, including the planned `messaging`
contract; the escape hatch (`durable`), which `schedule` relies on.

## 3. Compatibility

No installed workspace extensions define contracts today. A workspace
extension that still sets `contracts` has it ignored; one that provides a
non-core key fails to load with `unknown contract`, as any typo would.
`web` drops its `settings` schema entirely (`engine` was its only key), so a
leftover `extensions.web.engine` in `settings.json` is not validated and is
never read.

## 4. Testing

- Remove: `extension-defined contracts activate between tools and triggers`
  (`test/activation.test.ts`); the loader's contract-defining and pruning
  tests (`test/loader.test.ts`); web's engine-selection tests
  (`test/web.test.ts`); capabilities' contracts assertions.
- Add or keep: a `provides` key that isn't a core contract fails with
  `unknown contract`; `web_search` queries Brave and returns results;
  `web_search` with no key asks for `web.brave.apiKey`; `sdk.ts` no longer
  exports `Contract` or `CORE_CONTRACTS` (typecheck).
- `npm test` and `npm run typecheck` pass.
