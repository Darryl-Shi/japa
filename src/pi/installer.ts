// Extensions installed from chat, hot. A job writes one on the agent's computer: a TypeScript module (one file, or a
// directory with a package.json for its own npm packages) whose default export makes a JapaExtension from the Host,
// the same shape as the built-in ones, and it runs the same way: inside this process, with the Host, keys included.
// So only the user's tap installs it, every time, whatever the approvals mode. install_extension copies it here and
// checks it without running it (where it starts, its imports, its own packages installed without their scripts);
// one that wouldn't load goes back to the agent with why, and the user isn't asked. On Install it's loaded and on
// from the next message, with no restart; the chief of staff hears how it went. At start, what was installed before
// loads again. A new version replaces the old one in place.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type Registry, section } from "@earendil-works/pi-durable";
import type { Card } from "../core/ui.ts";
import type { ExtensionSet, Host, JapaExtension } from "./extension.ts";

export const EXTENSION_PREFIX = "[Extension ";
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const CODE_DIR = resolve(import.meta.dirname, "../..");
/** Its size, at most (node_modules and .git aside). */
const LIMIT = 48 * 1024 * 1024;

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
		`${repo} into a directory of its own on your computer and npm ci; the contract is src/pi/extension.ts, src/pi/web.ts is an example; write one`,
		"file (or a directory with a package.json for its own npm packages) whose default export is (host: Host) => JapaExtension;",
		"types only with `import type`; a key goes in a secret settings field the user sets in /settings, read with",
		'host.secrets.get("<name>.<key>"), never in the code; what japa is built from goes through its typed field: a model',
		"provider in `providers` (a pi-ai createProvider; its key comes from /login), a channel in",
		"`channel` (opened with its inbox, shows cards); npm run check passes. It runs inside the agent, like the built-in",
		"ones. Not a Pi coding-agent extension. It's checked before the user is asked, and a problem comes back to you.",
	].join(" ");

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Pending = { id: string; name: string; summary: string; from: string; entry?: string; lines?: number; packages?: string[]; hosts?: string[] };

/** Copy a file, or a directory's contents, into `into` (its node_modules and .git left behind). */
function copyFrom(path: string, into: string): void {
	if (!existsSync(path)) throw new Error(`no such file or directory: ${path}`);
	const directory = statSync(path).isDirectory();
	const size = directory ? files(path).filter((file) => !file.split("/").includes(".git")).reduce((sum, file) => sum + statSync(join(path, file)).size, 0) : statSync(path).size;
	if (size > LIMIT) throw new Error("it's too big");
	mkdirSync(into, { recursive: true });
	if (!directory) return cpSync(path, join(into, basename(path)));
	cpSync(path, into, { recursive: true, filter: (from) => from === path || ![".git", "node_modules"].includes(basename(from)) });
}

/** Every file under a directory, relative to it, in a stable order. */
function files(dir: string, under = dir): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => (entry.isDirectory() ? (entry.name === "node_modules" ? [] : files(join(dir, entry.name), under)) : [relative(under, join(dir, entry.name))]))
		.sort();
}

const packageOf = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
const isCode = (file: string) => /\.(m?[jt]s|cjs)$/.test(file);
const valueImports = (source: string) => [...new Set([...source.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm)].map((match) => match[1]!))];

/** Where it starts: package.json's main, an index file, or its one top-level file. */
function entryOf(dir: string): string {
	const path = join(dir, "package.json");
	const main = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { main?: unknown }).main : undefined;
	if (typeof main === "string" && existsSync(join(dir, main))) return main;
	const top = files(dir).filter((file) => !file.includes("/") && isCode(file));
	const entry = ["index.ts", "index.js", "index.mjs"].find((file) => top.includes(file)) ?? (top.length === 1 ? top[0] : undefined);
	if (entry === undefined) throw new Error('can\'t tell where it starts: give it one top-level .ts file, an index.ts, or "main" in package.json');
	return entry;
}

/** The package's directory, found the way Node finds it: in node_modules, from `from` up. */
function packageDir(name: string, from: string): string | undefined {
	for (let at = from; ; at = dirname(at)) {
		if (existsSync(join(at, "node_modules", name, "package.json"))) return join(at, "node_modules", name);
		if (dirname(at) === at) return undefined;
	}
}

/** Its exports, to say what's there when an import isn't. */
function exportsOf(dir: string): string {
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; exports?: unknown };
	return manifest.exports !== null && typeof manifest.exports === "object" ? ` (${manifest.name} exports ${Object.keys(manifest.exports).join(", ")})` : "";
}

/**
 * Its own npm packages: what its code imports that japa doesn't have. Packages japa has are japa's, found through
 * extensions/node_modules, so it runs against what japa runs; the rest are installed beside its code, without running
 * their scripts (nothing of it runs before the user says yes). Returns the packages installed.
 */
function installPackages(code: string): string[] {
	const imported = new Set(files(code).filter(isCode).flatMap((file) => valueImports(readFileSync(join(code, file), "utf8"))));
	const wanted = [...imported].filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:") && !builtinModules.includes(packageOf(specifier))).map(packageOf);
	const path = join(code, "package.json");
	const manifest = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string> }) : {};
	const own = [...new Set(wanted)].filter((name) => !existsSync(join(CODE_DIR, "node_modules", name, "package.json"))).sort();
	if (own.length === 0) return [];
	const dependencies = Object.fromEntries(own.map((name) => [name, manifest.dependencies?.[name] ?? "*"]));
	writeFileSync(path, `${JSON.stringify({ type: "module", ...manifest, dependencies }, null, "\t")}\n`);
	execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: code, stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60_000 });
	return own;
}

/** What would stop it loading, found without running it: no default export, or an import that doesn't resolve. */
export function problems(code: string, entry: string): string[] {
	const found: string[] = [];
	if (!/\bexport\s+default\b/.test(readFileSync(join(code, entry), "utf8"))) found.push(`${entry} has no default export`);
	for (const file of files(code).filter(isCode)) {
		const from = dirname(join(code, file));
		for (const specifier of valueImports(readFileSync(join(code, file), "utf8"))) {
			if (specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
			if (specifier.startsWith(".") || specifier.startsWith("/")) {
				if (!existsSync(resolve(from, specifier))) found.push(`${file}: "${specifier}" isn't there`);
				continue;
			}
			const dir = packageDir(packageOf(specifier), from) ?? packageDir(packageOf(specifier), CODE_DIR);
			if (dir === undefined) {
				found.push(`${file}: "${specifier}" isn't available`);
				continue;
			}
			// A package japa has resolves here exactly as it will there; a subpath it doesn't export is caught now.
			if (!realpathSync(dir).startsWith(realpathSync(join(CODE_DIR, "node_modules")))) continue;
			try {
				const url = import.meta.resolve(specifier);
				if (url.startsWith("file:") && !existsSync(fileURLToPath(url))) throw new Error("missing");
			} catch {
				found.push(`${file}: "${specifier}" isn't available${exportsOf(dir)}`);
			}
		}
	}
	return found;
}

/** Import its entry and make its extension. Each version has its own directory, so nothing comes from an older one. */
export async function loadExtension(path: string, host: Host): Promise<JapaExtension> {
	const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
	if (typeof module.default !== "function") throw new Error("its default export must be a function: (host) => extension");
	const entry = (await module.default(host)) as JapaExtension;
	if (typeof entry !== "object" || entry === null || typeof entry.name !== "string" || typeof entry.title !== "string" || typeof entry.about !== "string") {
		throw new Error("the extension needs a name, title and about");
	}
	return entry;
}

/** Web addresses in its code, for the card. */
function hostsIn(code: string): string[] {
	const found = new Set<string>();
	for (const file of files(code)) for (const match of readFileSync(join(code, file), "utf8").matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) found.add(match[1]!.toLowerCase());
	return [...found].sort();
}

const piExtensions = (entry: JapaExtension | undefined) => [...new Set([...(entry?.chief ?? []), ...(entry?.jobs ?? [])])];

export type Installer = {
	/** install_extension and remove_extension, for the chief of staff. */
	extension: Extension;
	/** The ones installed before, loaded again at start; a broken one is the chief of staff's news, and skipped. */
	loadInstalled(): Promise<JapaExtension[]>;
};

export function installer(options: {
	host: Host;
	dataDir: string;
	/** The agent's home: where a relative path it gives is from. */
	home: string;
	extensions: () => ExtensionSet;
	registry: Registry;
	/** Apply the change: the chief of staff's extensions, what's started, triggers. */
	apply: (context: Context) => Promise<void>;
	/** A problem the chief of staff should hear (an installed extension that no longer loads). */
	problem: (about: string, text: string | undefined) => void;
	context: Context;
}): Installer {
	const { host, registry } = options;
	const repo = origin();
	// data/extensions/<name>/<version>/: its code (and its own node_modules). Version ids sort by time.
	const dir = resolve(options.dataDir, "extensions");
	const pendingDir = join(dir, ".pending");
	/** Installed from chat (the rest are built in and can't be replaced from here). */
	const installed = new Set<string>();

	const prepare = () => {
		mkdirSync(pendingDir, { recursive: true });
		// It imports the packages japa has (pi-ai, pi-durable) as the built-in ones do, from japa's own node_modules.
		const modules = join(dir, "node_modules");
		if (!existsSync(modules)) symlinkSync(join(CODE_DIR, "node_modules"), modules, "dir");
	};

	/** Put it in the registry and the set, replacing an older version; refuses names taken by anything else. */
	const activate = async (entry: JapaExtension) => {
		const set = options.extensions();
		const old = set.get(entry.name);
		const own = new Set(piExtensions(old).map((extension) => extension.name));
		const taken = registry
			.snapshot()
			.installed()
			.filter((extension) => !own.has(extension.name))
			.map((extension) => extension.name);
		const clash = piExtensions(entry).find((extension) => taken.includes(extension.name));
		if (clash !== undefined) throw new Error(`its Pi extension name "${clash.name}" is already taken; pick another`);
		for (const extension of piExtensions(entry)) registry.install(extension);
		const kept = new Set(piExtensions(entry).map((extension) => extension.name));
		for (const extension of piExtensions(old)) if (!kept.has(extension.name)) registry.uninstall(extension);
		await set.put(entry);
		installed.add(entry.name);
		await options.apply(options.context);
	};

	const card = (pending: Pending, decided?: string): Card => ({
		text: [
			`${decided ?? "Install extension?"} ${pending.name}${installed.has(pending.name) ? " (replaces the installed one)" : ""}`,
			pending.summary,
			"",
			`${pending.lines ?? 0} lines from ${pending.from}. Web addresses in it: ${pending.hosts?.join(", ") || "none"}.`,
			...(pending.packages?.length ? [`Its own npm packages: ${pending.packages.join(", ")}.`] : []),
			"It runs inside the agent, with its settings and keys.",
		].join("\n"),
		...(decided === undefined ? { buttons: [[{ text: "Install", data: `extensions:${pending.id}:y` }, { text: "Don't install", data: `extensions:${pending.id}:n` }]] } : {}),
	});

	const tell = (pending: Pending, message: string, replyTo?: Parameters<Host["wake"]>[2]["replyTo"]) =>
		host.wake(host.chiefId(), `${EXTENSION_PREFIX}${pending.name}] ${message}`, { id: `extension:${pending.id}`, from: "installer", ...(replyTo === undefined ? {} : { replyTo }) });

	/** Check it without running it and, if it would load, ask the user; if not, the agent hears why. */
	const check = async (pending: Pending) => {
		const at = join(pendingDir, pending.id);
		try {
			// Its modules are ES modules, as japa's are, whether or not it says so.
			if (!existsSync(join(at, "package.json"))) writeFileSync(join(at, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
			const entry = entryOf(at);
			const packages = installPackages(at);
			const found = problems(at, entry);
			if (found.length > 0) throw new Error(`- ${found.join("\n- ")}`);
			const lines = files(at)
				.filter(isCode)
				.reduce((sum, file) => sum + readFileSync(join(at, file), "utf8").split("\n").length, 0);
			Object.assign(pending, { entry, lines, packages, hosts: hostsIn(at) });
			writeFileSync(join(pendingDir, `${pending.id}.json`), JSON.stringify(pending));
			await host.ui.show(card(pending));
		} catch (error) {
			rmSync(at, { recursive: true, force: true });
			await tell(pending, `It wouldn't load, so the user wasn't asked:\n${message(error)}\nFix it (in a job, against a clone of the repo, until npm run check passes), then install again.`);
		}
	};

	host.ui.handle("extensions", {
		press: async (payload, ref) => {
			const [id = "", choice] = payload.split(":");
			const meta = join(pendingDir, `${id}.json`);
			if (!existsSync(meta)) return;
			const pending = JSON.parse(readFileSync(meta, "utf8")) as Pending;
			rmSync(meta);
			const staged = join(pendingDir, id);
			if (choice !== "y") {
				rmSync(staged, { recursive: true, force: true });
				await host.ui.show(card(pending, "Not installed:"), ref);
				await tell(pending, "The user chose not to install it.", ref);
				return;
			}
			const target = join(dir, pending.name, id);
			try {
				mkdirSync(dirname(target), { recursive: true });
				renameSync(staged, target);
				const entry = await loadExtension(join(target, pending.entry!), host);
				if (entry.name !== pending.name) throw new Error(`it calls itself "${entry.name}", not "${pending.name}"`);
				await activate(entry);
				for (const other of versions(pending.name)) if (other !== id) rmSync(join(dir, pending.name, other), { recursive: true, force: true });
				await host.ui.show(card(pending, "Installed:"), ref);
				// One that failed to start is reported as a problem, with why; that's the chief of staff's news.
				if (options.extensions().failure(entry.name) !== undefined) return;
				const tools = piExtensions(entry).flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
				const where = [entry.chief?.length ? "you" : "", entry.jobs?.length ? "job agents" : ""].filter(Boolean).join(" and ");
				await tell(pending, `Installed and on from now${where === "" ? "" : ` for ${where}`}.${tools.length === 0 ? "" : ` Tools: ${[...new Set(tools)].join(", ")}.`}${entry.settings?.length ? " Its settings are in /settings." : ""}`, ref);
			} catch (error) {
				rmSync(target, { recursive: true, force: true });
				await host.ui.show(card(pending, "Failed to install:"), ref);
				await tell(pending, `The user approved it, but it failed to load: ${message(error)}. Nothing changed.`, ref);
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
				description: `Install an extension written on your computer into yourself, hot: it's checked, then the user is asked with buttons, and on Install it's on from the next message. A new version of an installed one replaces it. ${guide(repo)}`,
				parameters: Type.Object({
					path: Type.String({ description: "The .ts file, or its directory (with a package.json)" }),
					name: Type.String({ description: "The extension's name (lowercase-with-dashes), as in the code" }),
					summary: Type.String({ description: "For the user: what it does and what it reaches, in a sentence or two" }),
				}),
				execute: async (args) => {
					if (!NAME.test(args.name)) return text(`"${args.name}" isn't a valid name: lowercase letters, digits and dashes.`);
					if (options.extensions().get(args.name) !== undefined && !installed.has(args.name)) return text(`"${args.name}" is built in; pick another name.`);
					prepare();
					const pending: Pending = { id: Date.now().toString(36), name: args.name, summary: args.summary, from: args.path };
					try {
						copyFrom(resolve(options.home, args.path.replace(/^~(?=\/|$)/, options.home)), join(pendingDir, pending.id));
					} catch (error) {
						rmSync(join(pendingDir, pending.id), { recursive: true, force: true });
						return text(`Couldn't read ${args.path}: ${message(error)}`);
					}
					void check(pending);
					return text(
						`Checking it (${pending.id}); if it would load, the user is asked with buttons. Don't retry: end your turn with a short note. What happens comes as a message starting "${EXTENSION_PREFIX}${args.name}]".`,
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
					for (const extension of piExtensions(set.get(args.name))) registry.uninstall(extension);
					await set.remove(args.name);
					installed.delete(args.name);
					rmSync(join(dir, args.name), { recursive: true, force: true });
					await options.apply(options.context);
					return text(`Removed ${args.name}.`);
				},
			}),
		],
	});

	/** Its versions on disk, oldest first. */
	const versions = (name: string) =>
		existsSync(join(dir, name))
			? readdirSync(join(dir, name))
					.filter((each) => /^[0-9a-z]+$/.test(each) && statSync(join(dir, name, each)).isDirectory())
					.sort()
			: [];

	/**
	 * Older layouts, moved into place: one file (extensions/<name>.ts), or code/ beside what a sandbox kept
	 * (config.json, manifest.json, models-*.json). Either becomes its first version.
	 */
	const migrate = () => {
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && NAME.test(name.slice(0, -3)))) {
			const name = file.slice(0, -3);
			mkdirSync(join(dir, name, "0"), { recursive: true });
			renameSync(join(dir, file), join(dir, name, "0", file));
		}
		for (const name of readdirSync(dir).filter((each) => NAME.test(each) && existsSync(join(dir, each, "code")))) {
			if (!existsSync(join(dir, name, "0"))) renameSync(join(dir, name, "code"), join(dir, name, "0"));
			for (const file of readdirSync(join(dir, name))) if (file === "code" || file === "config.json" || file === "manifest.json" || /^models-.*\.json$/.test(file)) rmSync(join(dir, name, file), { recursive: true, force: true });
			const config = join(dir, name, "0", "config.json");
			if (existsSync(config)) rmSync(config);
		}
		for (const name of readdirSync(dir).filter((each) => NAME.test(each) && existsSync(join(dir, each, "0")) && !existsSync(join(dir, each, "0", "package.json")))) {
			writeFileSync(join(dir, name, "0", "package.json"), `${JSON.stringify({ type: "module" })}\n`);
		}
		// A sandbox removed the link to japa's packages; it's back.
		const modules = join(dir, "node_modules");
		if (existsSync(modules) && !lstatSync(modules).isSymbolicLink()) rmSync(modules, { recursive: true, force: true });
	};

	return {
		extension,
		loadInstalled: async () => {
			if (!existsSync(dir)) return [];
			migrate();
			prepare();
			const entries: JapaExtension[] = [];
			for (const name of readdirSync(dir).filter((each) => NAME.test(each)).sort()) {
				const version = versions(name).at(-1);
				if (version === undefined) continue;
				try {
					const at = join(dir, name, version);
					const entry = await loadExtension(join(at, entryOf(at)), host);
					if (entry.name !== name) throw new Error(`it calls itself "${entry.name}"`);
					entries.push(entry);
					installed.add(entry.name);
				} catch (error) {
					host.log(`extension ${name}: not loaded: ${message(error)}`);
					options.problem(`extension ${name}`, `it no longer loads: ${message(error)}`);
				}
			}
			return entries;
		},
	};
}
