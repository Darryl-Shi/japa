# japa: a "Web UI" section in `japa setup`

Status: spec for an incremental change to japa (repo `Darryl-Shi/japa`). The builder folds it into `docs/spec.md` as a new section (and notes it in the `webui` spec, §2.3) and updates the README and PROGRESS.md.

## 1. Purpose

The web UI (`webui` extension) is on by default and ships with japa. It has several settings: whether it's on, the address it listens on, its port, and extra host names. Today none of these has a home in `japa setup`. Every `extensions.webui` setting is optional and its only secret is generated, so `configurable()` leaves it out of the Integrations step. You can only change them by editing `settings.json`, through Telegram `/settings` → Extensions, or by asking the CoS.

This change adds a dedicated, top-level **Web UI** section to `japa setup`'s rerun menu. It shows how the web UI is currently set up and lets you change each setting with guided choices instead of raw values.

**Out of scope:**
- **Authentication.** The `webui.token` secret, sign-in and sessions are being replaced by user auth in another ticket. This section neither shows nor regenerates the token, and must not depend on the token mechanism.
- **Other settings surfaces.** Telegram `/settings` keeps exactly its current behaviour, and so do the web UI app and the CoS's settings tools.
- **The `webui` extension.** Its manifest, settings schema, defaults, runtime behaviour and status line are unchanged.
- **Non-interactive setup.** `--non-interactive` gets no new env vars.

## 2. Key technical decisions

### 2.1 Where it lives
- **Rerun menu.** The `japa setup` rerun menu (`models.cos` already set) gains an item, **Web UI**, with the hint "the browser chat: on/off, address, port, host names". It goes after "Integrations" and before "Background service". The order becomes: Model and sign-in, Integrations, Web UI, Background service, Done.
- **First run is unchanged.** Its closing summary already prints `japa status`, which includes the `webui` line with the URL. There is no new first-run step.
- **Integrations and `--whats-new` are unchanged.** `webui` still doesn't appear in the Integrations multiselect, because it has nothing to set up.
- **Code location.** The section lives in `src/cli/` as its own module (e.g. `webui-step.ts`), next to `models-step.ts`. It drives the existing `Prompter`, so the existing fake-prompter tests can script it.
- **Missing extension.** If no extension named `webui` is loaded in the setup context (for example, removed from a fork), the item still shows. Choosing it prints `The web UI extension isn't installed.` and returns to the menu.

### 2.2 What the section does
- **Overview.** On entry it shows an overview box with:
  - the state (`on` / `off`);
  - the address(es) to open (§2.3);
  - `bind`, `port` and `hosts`, each with `(default)` when unset;
  - a one-line note: "In a Docker instance, the host port and address are set by the installer (`--webui-port`, `--webui-bind`); keep these at their defaults there."

  This note is plain text shown everywhere. There is no container detection: the no-container-code-paths rule holds.
- **Menu.** A select loop follows, offering:
  - **Turn off** / **Turn on**, depending on the current state;
  - **Listen address**;
  - **Port**;
  - **Host names**;
  - **Reset to defaults**;
  - **Done**.

  Each change is saved straight away. The overview is shown again after every change, and Done returns to the rerun menu.
- **Turn off** writes `extensions.webui.enabled: false`. **Turn on** removes the `enabled` key. The other items stay available while it's off.
- **Listen address** is a select:
  - "This machine only" → `127.0.0.1`, the default. Choosing it removes `bind`.
  - One entry per non-internal IPv4 address from `os.networkInterfaces()`, labelled with its interface. An address in `100.64.0.0/10`, or on an interface named `tailscale*`, is labelled "Tailscale".
  - "All addresses (0.0.0.0)". Choosing it first asks for confirmation with a warning that the UI is plain HTTP, so it should only be exposed on trusted networks.
  - "Other…": a text prompt that accepts an IP literal (`node:net` `isIP`), re-asking otherwise.

  The current value is preselected. A current value that isn't in the list appears as its own entry.
- **Port** is a text prompt, prefilled with the current value or 7337. It accepts an integer from 1 to 65535 and re-asks otherwise. A blank answer, or 7337, removes `port`.
- **Host names** is a text prompt: a comma-separated list, prefilled with the current names. Each entry is trimmed and lower-cased. It must be a DNS name with no scheme, port, path or spaces, and must not be an IP literal (IPs are always accepted anyway). Any invalid entry re-asks and names it. Duplicates are dropped. A blank answer removes `hosts`.
- **Reset to defaults** asks for confirmation, then removes `bind`, `port`, `hosts` and `enabled` from `extensions.webui`.
- **Saving.**
  - Every write goes through the user settings file (`readUserSettings` / `setPath` / `saveSettings`). It touches only `extensions.webui`, and keeps any other keys there.
  - It is validated with `validateExtensionSettings` against the extension's own schema, as `configureExtension` does.
  - Removing the last key leaves `extensions.webui` as `{}` or removes it; either is fine.
- **Restart.** A change counts as "saved" for the rerun loop. As with the other items, if the service is active when setup finishes, the rerun's existing "Restarting japa to apply the changes." step restarts it. No other restart logic is added.

### 2.3 The address shown
This is a pure function of the settings and the network interfaces, computed by the wizard. It doesn't need the daemon.
- **Off:** `off — turn it on to use it`.
- **Bound to a specific address:** `http://<bind>:<port>`, with IPv6 in brackets.
- **Bound to `0.0.0.0` (or `::`):** `http://127.0.0.1:<port>`, plus `http://<addr>:<port>` for each detected non-internal IPv4 address.
- **Host names:** each name in `hosts` adds `http://<name>:<port>`.

## 3. Docs
- **README.**
  - The Web UI section's Settings bullet says you can change them with `japa setup` → Web UI, besides `settings.json`, `/settings` and the CoS.
  - The setup paragraph ("The wizard covers models, sign-in, integrations and the service") mentions the Web UI section.
- **`docs/spec.md` and PROGRESS.md** are updated.

## Acceptance behaviours

1. With a configured japa (`models.cos` set), `japa setup` shows the menu items in this order: Model and sign-in, Integrations, Web UI, Background service, Done.
2. Choosing Web UI on a fresh settings file shows `on`, `http://127.0.0.1:7337`, and `bind`/`port`/`hosts` marked as defaults, plus the Docker note. The token is not shown anywhere in the section.
3. Choosing Port and entering `8080` writes `"port": 8080` under `extensions.webui` in `~/.japa/settings.json`. The overview then shows `http://127.0.0.1:8080`. Entering `70000` or `abc` re-asks without saving.
4. Choosing Listen address lists "This machine only", each detected LAN/Tailscale IPv4 address with its interface, "All addresses (0.0.0.0)" and "Other…".
   - Picking a LAN address writes `bind` to it.
   - Picking "All addresses" warns about plain HTTP and asks for confirmation first, and the overview then lists `127.0.0.1` and every detected address.
   - Under "Other…", `not-an-ip` is refused.
5. Entering `Japa.Example.Corp, foo.lan` under Host names writes `"hosts": ["japa.example.corp", "foo.lan"]`. `http://x:1`, `10.0.0.1` and `a b` are each refused by name. A blank answer removes `hosts`.
6. Turn off writes `"enabled": false`, and the overview shows the web UI as off. Turn on removes the key. After the restart, `japa status` shows the `webui` line, or doesn't, to match.
7. Reset to defaults, once confirmed, removes `bind`, `port`, `hosts` and `enabled`, and leaves every other setting in `settings.json` untouched.
8. With the service active, changing the port and then choosing Done prints "Restarting japa to apply the changes.". Afterwards the web UI answers on the new port, and `japa status` shows the new URL.
9. Entering the section and choosing Done without changes writes nothing and doesn't restart the service.
10. First-run setup, `--non-interactive` and `--whats-new` behave as before, and the Integrations step still doesn't list `webui`.
11. `npm test` and `npm run typecheck` pass. New tests drive the section through the fake prompter.
