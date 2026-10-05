// Extensions installed from chat, hot. A job writes one on the workbench: a TypeScript module (one file, or a
// directory with a package.json) whose default export makes a JapaExtension from the Host, the same shape as the
// built-in ones. install_extension copies it here and loads it in its sandbox (src/pi/sandbox.ts: its own machine,
// never inside the agent) to see what it declares; one that doesn't load goes back to the agent with why. Only then
// is the user shown what it would get and asked with buttons, every time, whatever the approvals mode. On Install
// its stand-in is registered and it's on from the next message, with no restart; the chief of staff hears how it
// went. At start, what was installed before is registered again from what it declared, without waiting on the
// machine. A new version replaces the old one in place.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type Models, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type Registry, section } from "@earendil-works/pi-durable";
import type { Inbox } from "../channels/inbox.ts";
import { type Backend, shellQuote as q } from "../core/backend.ts";
import type { Card } from "../core/ui.ts";
import type { ExtensionSet, Host, JapaExtension } from "./extension.ts";
import { grants, type Manifest, prepareBundle, readManifest, Sandbox, standIn } from "./sandbox.ts";

export const EXTENSION_PREFIX = "[Extension ";
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const CODE_DIR = resolve(import.meta.dirname, "../..");
/** What's read from the workbench, at most (base64). */
const LIMIT = 64 * 1024 * 1024;

function origin(): string {
	try {
		return execFileSync("git", ["-C", CODE_DIR, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "the agent's repo";
	} catch {
		return "the agent's repo";
	}
}

/** How to write one: what a job's brief must say. In the tool description, read when it's needed, not every turn. */
const guide = (repo: string) =>
	[
		"A job writes it; its brief must say: clone",
		`${repo} on the workbench and npm ci; the contract is src/pi/extension.ts, src/pi/web.ts is an example; write one`,
		"file (or a directory with a package.json for its own npm packages) whose default export is (host: Host) => JapaExtension;",
		"types only with `import type`; a key goes in a secret settings field the user sets in /settings, read with",
		'host.secrets.get("<name>.<key>") and used only in fetch (it gets a placeholder the agent fills in), never in the code;',
		"what japa is built from goes through its typed field: a model provider in `providers` (a pi-ai createProvider on a",
		"built-in API; its key comes from /login), a channel in `channel` (opened with its inbox, shows cards); npm run check",
		"passes. It runs on its own machine, not in the agent: no durable tasks or machine providers. Not a Pi coding-agent",
		"extension. It's loaded there before the user is asked, and a failure comes back to you.",
	].join(" ");

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Pending = { id: string; name: string; summary: string; from: string; packages?: string[]; hosts?: string[] };

/** Copy a file or directory from a machine into `into` (its node_modules and .git left behind). */
async function copyFrom(machine: Backend, path: string, into: string): Promise<void> {
	const at = path.startsWith("~/") ? path.slice(2) : path;
	const script = [
		`p=${q(at)}`,
		'[ -e "$p" ] || { echo "no such file or directory: $p"; exit 1; }',
		'if [ -d "$p" ]; then c="$p"; n=.; else c="$(dirname "$p")"; n="$(basename "$p")"; fi',
		'e="$(mktemp)"',
		`tar -czf - --exclude=node_modules --exclude=.git -C "$c" "$n" 2>"$e" | base64 | tr -d '\\n'`,
		's="${PIPESTATUS[0]}"',
		'if [ "$s" != 0 ]; then echo; cat "$e"; rm -f "$e"; exit 1; fi',
		'rm -f "$e"',
	].join("\n");
	let output = "";
	const { exitCode } = await machine.exec(script, { onOutput: (chunk) => (output.length < LIMIT ? (output += chunk) : undefined) });
	if (output.length >= LIMIT) throw new Error("it's too big");
	if (exitCode !== 0) throw new Error(output.trim().split("\n").at(-1) || `exit ${exitCode}`);
	mkdirSync(into, { recursive: true });
	execFileSync("tar", ["-xzf", "-", "-C", into], { input: Buffer.from(output.trim(), "base64") });
}

/** Web addresses in its code, for the card. */
function hostsIn(dir: string): string[] {
	const found = new Set<string>();
	const walk = (at: string) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(join(at, entry.name));
			else for (const match of readFileSync(join(at, entry.name), "utf8").matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) found.add(match[1]!.toLowerCase());
		}
	};
	walk(dir);
	return [...found].sort();
}

const piNames = (manifest: Manifest) => manifest.extensions.map((spec) => spec.name);

export type Installer = {
	/** install_extension and remove_extension, for the chief of staff. */
	extension: Extension;
	/** The ones installed before, registered again at start from what they declared. */
	loadInstalled(): Promise<JapaExtension[]>;
	/** Once japa is up: any installed in an older layout are loaded in their sandbox, and on once they load. */
	resume(): void;
};

export function installer(options: {
	host: Host;
	dataDir: string;
	extensions: () => ExtensionSet;
	registry: Registry;
	/** The machine extensions run on. */
	machine: () => Backend | undefined;
	models: Models;
	inbox: (platform: string) => Inbox;
	/** Apply the change: the chief of staff's extensions, what's started, triggers. */
	apply: (context: Context) => Promise<void>;
	/** A problem the chief of staff should hear (an installed extension that doesn't load or stopped running). */
	problem: (about: string, text: string | undefined) => void;
	context: Context;
}): Installer {
	const { host, registry } = options;
	const repo = origin();
	const dir = resolve(options.dataDir, "extensions");
	const pendingDir = join(dir, ".pending");
	/** Installed from chat, by name (the rest are built in and can't be replaced from here). */
	const installed = new Map<string, Sandbox>();
	/** Moved from an older layout, not yet loaded here. */
	const unchecked: string[] = [];

	const sandbox = (name: string, at: string, report = true) =>
		new Sandbox({
			name,
			dir: at,
			machine: options.machine,
			host,
			models: options.models,
			inbox: options.inbox,
			problem: report ? (problem) => options.problem(`extension ${name}`, problem) : () => {},
			context: options.context,
		});

	/** Pi extension names it would take that something else already has. */
	const clash = (manifest: Manifest) => {
		const old = options.extensions().get(manifest.name);
		const own = new Set([...(old?.chief ?? []), ...(old?.jobs ?? [])].map((extension) => extension.name));
		const taken = registry
			.snapshot()
			.installed()
			.map((extension) => extension.name)
			.filter((name) => !own.has(name));
		return piNames(manifest).find((name) => taken.includes(name));
	};

	/** Put its stand-in in the registry and the set, replacing an older version. */
	const activate = async (entry: JapaExtension, running: Sandbox) => {
		const set = options.extensions();
		const old = set.get(entry.name);
		const pis = [...new Set([...(entry.chief ?? []), ...(entry.jobs ?? [])])];
		for (const extension of pis) registry.install(extension);
		const kept = new Set(pis.map((extension) => extension.name));
		for (const extension of new Set([...(old?.chief ?? []), ...(old?.jobs ?? [])])) if (!kept.has(extension.name)) registry.uninstall(extension);
		await set.put(entry);
		installed.set(entry.name, running);
		await options.apply(options.context);
	};

	const card = (pending: Pending, manifest: Manifest, decided?: string): Card => ({
		text: [
			`${decided ?? "Install extension?"} ${pending.name}${installed.has(pending.name) ? " (replaces the installed one)" : ""}`,
			pending.summary,
			"",
			...grants(manifest, pending.packages ?? []).map((line) => `• ${line}`),
			"",
			`From ${pending.from} on the workbench. Web addresses in it: ${pending.hosts?.join(", ") || "none"}.`,
			"It runs on its own machine, not inside the agent, and never sees the agent's keys.",
		].join("\n"),
		...(decided === undefined ? { buttons: [[{ text: "Install", data: `extensions:${pending.id}:y` }, { text: "Don't install", data: `extensions:${pending.id}:n` }]] } : {}),
	});

	const tell = (pending: Pending, message: string, replyTo?: Parameters<Host["wake"]>[2]["replyTo"]) =>
		host.wake(host.chiefId(), `${EXTENSION_PREFIX}${pending.name}] ${message}`, { id: `extension:${pending.id}`, from: "installer", ...(replyTo === undefined ? {} : { replyTo }) });

	/** Load it in its sandbox and, if it loads, ask the user; if not, the agent hears why. */
	const check = async (pending: Pending) => {
		const at = join(pendingDir, pending.id);
		try {
			const { packages } = prepareBundle(at, pending.name);
			const manifest = await sandbox(pending.name, at, false).inspect();
			const taken = clash(manifest);
			if (taken !== undefined) throw new Error(`its Pi extension name "${taken}" is already taken; pick another`);
			Object.assign(pending, { packages, hosts: hostsIn(join(at, "code")) });
			writeFileSync(join(at, "manifest.json"), JSON.stringify(manifest));
			writeFileSync(join(at, "pending.json"), JSON.stringify(pending));
			await host.ui.show(card(pending, manifest));
		} catch (error) {
			rmSync(at, { recursive: true, force: true });
			await tell(pending, `It didn't load in its sandbox, so the user wasn't asked: ${message(error)}\nFix it (in a job, against a clone of the repo, until npm run check passes), then install again.`);
		}
	};

	host.ui.handle("extensions", {
		press: async (payload, ref) => {
			const [id = "", choice] = payload.split(":");
			const at = join(pendingDir, id);
			if (!existsSync(join(at, "pending.json"))) return;
			const pending = JSON.parse(readFileSync(join(at, "pending.json"), "utf8")) as Pending;
			const manifest = readManifest(at)!;
			if (choice !== "y") {
				rmSync(at, { recursive: true, force: true });
				await host.ui.show(card(pending, manifest, "Not installed:"), ref);
				await tell(pending, "The user chose not to install it.", ref);
				return;
			}
			const target = join(dir, pending.name);
			try {
				rmSync(join(at, "pending.json"));
				const old = installed.get(pending.name);
				if (old !== undefined) await old.stop();
				rmSync(target, { recursive: true, force: true });
				renameSync(at, target);
				const running = sandbox(pending.name, target);
				const entry = standIn(manifest, running, host.log);
				await activate(entry, running);
				await host.ui.show(card(pending, manifest, "Installed:"), ref);
				// One that doesn't start is reported as a problem, with why; that's the chief of staff's news.
				if (options.extensions().enabled(entry) && !(await running.up().then(() => true, () => false))) return;
				const tools = [...(entry.chief ?? []), ...(entry.jobs ?? [])].flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
				const where = [entry.chief?.length ? "you" : "", entry.jobs?.length ? "job agents" : ""].filter(Boolean).join(" and ");
				await tell(pending, `Installed and on from now${where === "" ? "" : ` for ${where}`}.${tools.length === 0 ? "" : ` Tools: ${[...new Set(tools)].join(", ")}.`}${entry.settings?.length ? " Its settings are in /settings." : ""}`, ref);
			} catch (error) {
				rmSync(at, { recursive: true, force: true });
				await host.ui.show(card(pending, manifest, "Failed to install:"), ref);
				await tell(pending, `The user approved it, but it failed to install: ${message(error)}.`, ref);
			}
		},
	});

	const extension = defineExtension({
		name: "jarvis.installer",
		sections: [
			section(
				"extending",
				() =>
					"You are built to be customized: beyond your core (this conversation, open items, the team, triggers), everything you can do is an extension the user turns on or off in /settings. You can't change your own settings. You can add extensions yourself: have a job write one, then install_extension; it's on from the next message once the user approves. Never say something is installed before you hear it is.",
			),
		],
		tools: [
			defineTool({
				name: "install_extension",
				description: `Install an extension written on your computer (the workbench) into yourself, hot: it's loaded in its sandbox, then the user is asked with buttons, and on Install it's on from the next message. A new version of an installed one replaces it. ${guide(repo)}`,
				parameters: Type.Object({
					path: Type.String({ description: "The .ts file, or its directory (with a package.json), on the workbench" }),
					name: Type.String({ description: "The extension's name (lowercase-with-dashes), as in the code" }),
					summary: Type.String({ description: "For the user: what it does and what it reaches, in a sentence or two" }),
				}),
				execute: async (args) => {
					if (!NAME.test(args.name)) return text(`"${args.name}" isn't a valid name: lowercase letters, digits and dashes.`);
					if (options.extensions().get(args.name) !== undefined && !installed.has(args.name)) return text(`"${args.name}" is built in; pick another name.`);
					const workbench = host.workbench();
					if (workbench === undefined) return text("There's no workbench to read it from.");
					const pending: Pending = { id: Date.now().toString(36), name: args.name, summary: args.summary, from: args.path };
					try {
						await copyFrom(workbench, args.path, join(pendingDir, pending.id, "code"));
					} catch (error) {
						rmSync(join(pendingDir, pending.id), { recursive: true, force: true });
						return text(`Couldn't read ${args.path}: ${message(error)}`);
					}
					void check(pending);
					return text(
						`Loading it in its sandbox (${pending.id}); if it loads, the user is asked with buttons. Don't retry: end your turn with a short note. What happens comes as a message starting "${EXTENSION_PREFIX}${args.name}]".`,
					);
				},
			}),
			defineTool({
				name: "remove_extension",
				description: "Remove an extension installed from chat (only when the user asks). Built-in ones can only be turned off, in /settings.",
				parameters: Type.Object({ name: Type.String() }),
				execute: async (args) => {
					if (!installed.has(args.name)) return text(`"${args.name}" wasn't installed from chat.`);
					const set = options.extensions();
					const entry = set.get(args.name);
					for (const extension of new Set([...(entry?.chief ?? []), ...(entry?.jobs ?? [])])) registry.uninstall(extension);
					await set.remove(args.name);
					installed.delete(args.name);
					rmSync(join(dir, args.name), { recursive: true, force: true });
					await options.apply(options.context);
					return text(`Removed ${args.name}.`);
				},
			}),
		],
	});

	/** An older layout (one file, data/extensions/<name>.ts, run inside the agent) moved to its own directory. */
	const migrate = () => {
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
			const name = file.replace(/\.ts$/, "");
			mkdirSync(join(dir, name, "code"), { recursive: true });
			renameSync(join(dir, file), join(dir, name, "code", file));
		}
		const modules = join(dir, "node_modules");
		if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) rmSync(modules);
	};

	return {
		extension,
		loadInstalled: async () => {
			if (!existsSync(dir)) return [];
			migrate();
			const entries: JapaExtension[] = [];
			for (const name of readdirSync(dir).filter((each) => !each.startsWith(".") && NAME.test(each)).sort()) {
				const at = join(dir, name);
				const manifest = readManifest(at);
				if (manifest === undefined) {
					unchecked.push(name);
					continue;
				}
				const running = sandbox(name, at);
				entries.push(standIn(manifest, running, host.log));
				installed.set(name, running);
			}
			return entries;
		},
		resume: () => {
			for (const name of unchecked.splice(0)) {
				const at = join(dir, name);
				void (async () => {
					try {
						prepareBundle(at, name);
						const running = sandbox(name, at);
						const manifest = await running.inspect();
						writeFileSync(join(at, "manifest.json"), JSON.stringify(manifest));
						await activate(standIn(manifest, running, host.log), running);
					} catch (error) {
						host.log(`extension ${name}: not loaded: ${message(error)}`);
						options.problem(`extension ${name}`, `it no longer loads: ${message(error)}`);
					}
				})();
			}
		},
	};
}
