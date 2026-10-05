// Extensions installed from chat, hot-loaded. A job writes one on the workbench: a TypeScript module whose default
// export makes a JarvisExtension from the Host, the same shape as the built-in ones. install_extension shows the user
// what it is and asks with buttons, every time, whatever the approvals mode: the code runs inside this process with
// the Host, keys included, so only the user's tap installs it. On Install it is loaded, copied into
// data/extensions, and on from the next message, with no restart; the chief of staff hears how it went. At start,
// what was installed before loads again. A new version replaces the old one in place.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type Registry, section } from "@earendil-works/pi-durable";
import type { Card } from "../core/ui.ts";
import { BackendExecutionEnv } from "./backend-env.ts";
import type { ExtensionSet, Host, JarvisExtension } from "./extension.ts";

export const EXTENSION_PREFIX = "[Extension ";
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const CODE_DIR = resolve(import.meta.dirname, "../..");

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
		"file anywhere npm run check covers, whose default export is (host: Host) => JarvisExtension; import values only from packages",
		"(@earendil-works/pi-ai, @earendil-works/pi-durable, node:*), types only with `import type`; a key goes in a secret",
		'settings field the user sets in /settings, read with host.secrets.get("<name>.<key>"), never in the code; a model',
		"provider is an extension whose start() calls host.models.setProvider (and host.models.refresh for it, if it fetches its",
		"model list), with its key from /login; npm run check passes. Not a Pi coding-agent",
		"extension. The file is checked before the user is asked.",
	].join(" ");

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

type Pending = { id: string; name: string; summary: string; from: string };

/** Import a module (fresh, never from the import cache) and make its extension. */
export async function loadExtension(path: string, host: Host): Promise<JarvisExtension> {
	const module = (await import(`${pathToFileURL(path).href}?v=${Date.now()}`)) as { default?: unknown };
	if (typeof module.default !== "function") throw new Error("its default export must be a function: (host) => extension");
	const entry = (await module.default(host)) as JarvisExtension;
	if (typeof entry !== "object" || entry === null || typeof entry.name !== "string" || typeof entry.title !== "string" || typeof entry.about !== "string") {
		throw new Error("the extension needs a name, title and about");
	}
	return entry;
}

/** Its exports, to say what's there when an import isn't. */
function exportsOf(specifier: string): string {
	const parts = specifier.split("/");
	const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
	try {
		const manifest = JSON.parse(readFileSync(join(CODE_DIR, "node_modules", name, "package.json"), "utf8")) as { exports?: Record<string, unknown> };
		return manifest.exports === undefined ? "" : ` (${name} exports ${Object.keys(manifest.exports).join(", ")})`;
	} catch {
		return ` (${name} isn't installed)`;
	}
}

/**
 * What would stop it loading, found without running it: no default export, or a value import that doesn't resolve.
 * Installed extensions import from japa's own node_modules, so resolving from here is resolving from there.
 */
export function problems(source: string): string[] {
	const found: string[] = [];
	if (!/\bexport\s+default\b/.test(source)) found.push("it has no default export");
	const specifiers = [...source.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm)].map((match) => match[1]!);
	for (const specifier of new Set(specifiers)) {
		if (specifier.startsWith(".") || specifier.startsWith("/")) {
			found.push(`"${specifier}": it must be one file, importing values only from packages (types with import type)`);
			continue;
		}
		try {
			const url = import.meta.resolve(specifier);
			if (url.startsWith("file:") && !existsSync(fileURLToPath(url))) throw new Error("missing");
		} catch {
			found.push(`"${specifier}" isn't available${exportsOf(specifier)}`);
		}
	}
	return found;
}

const piExtensions = (entry: JarvisExtension | undefined) => [...new Set([...(entry?.chief ?? []), ...(entry?.jobs ?? [])])];

export type Installer = {
	/** install_extension and remove_extension, for the chief of staff. */
	extension: Extension;
	/** The ones installed before, loaded again at start; a broken one is logged and skipped. */
	loadInstalled(): Promise<JarvisExtension[]>;
};

export function installer(options: {
	host: Host;
	dataDir: string;
	extensions: () => ExtensionSet;
	registry: Registry;
	/** Apply the change: the chief of staff's extensions, what's started, triggers. */
	apply: (context: Context) => Promise<void>;
	context: Context;
}): Installer {
	const { host, registry } = options;
	const repo = origin();
	const dir = resolve(options.dataDir, "extensions");
	const pendingDir = join(dir, ".pending");
	/** Installed from chat (the rest are built in and can't be replaced from here). */
	const installed = new Set<string>();

	const prepare = () => {
		mkdirSync(pendingDir, { recursive: true });
		// An extension imports packages (pi-ai, pi-durable) as the built-in ones do, from japa's own node_modules.
		const modules = join(dir, "node_modules");
		if (!existsSync(modules)) symlinkSync(join(CODE_DIR, "node_modules"), modules, "dir");
	};

	/** Put it in the registry and the set, replacing an older version; refuses names taken by anything else. */
	const activate = async (entry: JarvisExtension) => {
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

	const card = (pending: Pending, source: string, decided?: string): Card => {
		const hosts = [...new Set([...source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1]!.toLowerCase()))];
		const replaces = installed.has(pending.name) ? " (replaces the installed one)" : "";
		return {
			text: [
				`${decided ?? "Install extension?"} ${pending.name}${replaces}`,
				pending.summary,
				"",
				`${source.split("\n").length} lines from ${pending.from} on the workbench. Web addresses in it: ${hosts.join(", ") || "none"}.`,
				"It runs inside the agent, with its settings and keys.",
			].join("\n"),
			...(decided === undefined
				? { buttons: [[{ text: "Install", data: `extensions:${pending.id}:y` }, { text: "Don't install", data: `extensions:${pending.id}:n` }]] }
				: {}),
		};
	};

	const tell = (pending: Pending, message: string, replyTo: Parameters<Host["wake"]>[2]["replyTo"]) =>
		host.wake(host.chiefId(), `${EXTENSION_PREFIX}${pending.name}] ${message}`, { id: `extension:${pending.id}`, ...(replyTo === undefined ? {} : { replyTo }) });

	host.ui.handle("extensions", {
		press: async (payload, ref) => {
			const [id = "", choice] = payload.split(":");
			const meta = join(pendingDir, `${id}.json`);
			const staged = join(pendingDir, `${id}.ts`);
			if (!existsSync(meta)) return;
			const pending = JSON.parse(readFileSync(meta, "utf8")) as Pending;
			const source = readFileSync(staged, "utf8");
			rmSync(meta);
			if (choice !== "y") {
				rmSync(staged, { force: true });
				await host.ui.show(card(pending, source, "Not installed:"), ref);
				await tell(pending, "The user chose not to install it.", ref);
				return;
			}
			try {
				const entry = await loadExtension(staged, host);
				if (entry.name !== pending.name) throw new Error(`it calls itself "${entry.name}", not "${pending.name}"`);
				await activate(entry);
				renameSync(staged, join(dir, `${pending.name}.ts`));
				await host.ui.show(card(pending, source, "Installed:"), ref);
				const tools = piExtensions(entry).flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
				const where = [entry.chief?.length ? "you" : "", entry.jobs?.length ? "job agents" : ""].filter(Boolean).join(" and ");
				await tell(pending, `Installed and on from now${where === "" ? "" : ` for ${where}`}.${tools.length === 0 ? "" : ` Tools: ${tools.join(", ")}.`}${entry.settings?.length ? " Its settings are in /settings." : ""}`, ref);
			} catch (error) {
				rmSync(staged, { force: true });
				await host.ui.show(card(pending, source, "Failed to install:"), ref);
				await tell(pending, `The user approved it, but it failed to load: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`, ref);
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
				description: `Install an extension written on your computer (the workbench) into yourself, hot: the user is asked with buttons, and on Install it's on from the next message. A new version of an installed one replaces it. ${guide(repo)}`,
				parameters: Type.Object({
					path: Type.String({ description: "The .ts file on the workbench" }),
					name: Type.String({ description: "The extension's name (lowercase-with-dashes), as in the file" }),
					summary: Type.String({ description: "For the user: what it does and what it reaches, in a sentence or two" }),
				}),
				execute: async (args, _api, context) => {
					if (!NAME.test(args.name)) return text(`"${args.name}" isn't a valid name: lowercase letters, digits and dashes.`);
					if (options.extensions().get(args.name) !== undefined && !installed.has(args.name)) return text(`"${args.name}" is built in; pick another name.`);
					if (host.workbench === undefined) return text("There's no workbench to read it from.");
					const read = await new BackendExecutionEnv(host.workbench).readTextFile(args.path, context);
					if (!read.ok) return text(`Couldn't read ${args.path}: ${String(read.error)}`);
					const found = problems(read.value);
					if (found.length > 0) return text(`Not asking the user: it wouldn't load.\n- ${found.join("\n- ")}\nFix it (in a job, against a clone of the repo, until npm run check passes), then install again.`);
					prepare();
					const pending: Pending = { id: Date.now().toString(36), name: args.name, summary: args.summary, from: args.path };
					writeFileSync(join(pendingDir, `${pending.id}.ts`), read.value);
					writeFileSync(join(pendingDir, `${pending.id}.json`), JSON.stringify(pending));
					await host.ui.show(card(pending, read.value));
					return text(
						`Asked the user (${pending.id}). Don't retry: end your turn with a short note. Their decision comes as a message starting "${EXTENSION_PREFIX}${args.name}]".`,
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
					rmSync(join(dir, `${args.name}.ts`), { force: true });
					await options.apply(options.context);
					return text(`Removed ${args.name}.`);
				},
			}),
		],
	});

	return {
		extension,
		loadInstalled: async () => {
			if (!existsSync(dir)) return [];
			prepare();
			const entries: JarvisExtension[] = [];
			for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts")).sort()) {
				try {
					const entry = await loadExtension(join(dir, file), host);
					if (`${entry.name}.ts` !== file) throw new Error(`it calls itself "${entry.name}"`);
					entries.push(entry);
					installed.add(entry.name);
				} catch (error) {
					host.log(`extension ${file}: not loaded: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return entries;
		},
	};
}
