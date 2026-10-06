// The core's owners of what extensions register (Owners, in extension.ts): what it means for each kind to be in use,
// whichever extension registered it. Accounts, schedules and MCP servers have modules of their own.
import type { Context } from "@earendil-works/chord";
import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
import type { Inbox } from "../channels/inbox.ts";
import type { UI } from "../core/ui.ts";
import type { Channel, CommandOptions, Owner } from "./extension.ts";

/** Slash commands, on the UI. A name that's taken (by the core, or another extension) is refused. */
export function commandOwner(ui: UI): Owner<CommandOptions> {
	const offered = new Map<string, CommandOptions>();
	return {
		add: (name, command, from) => {
			if (!offered.has(name) && ui.commands().some((each) => each.name === name)) throw new Error(`/${name} is already a command`);
			offered.set(name, command);
			ui.command(name, command.description ?? name, async (at, args) => command.handler(args, await from.context({ at })));
		},
		remove: (name, command) => {
			if (offered.get(name) !== command) return;
			offered.delete(name);
			ui.removeCommand(name);
		},
	};
}

/** Model providers, on Models. One that replaces a provider Models already had gives it back when it's off. */
/** `added`: told each provider's id once it's in use. */
export function providerOwner(models: MutableModels, added: (id: string) => void): Owner<Provider> {
	const own = new Map<string, Provider>();
	/** What each replaced, if anything. */
	const replaced = new Map<string, Provider | undefined>();
	return {
		add: (id, provider) => {
			if (own.has(id)) throw new Error(`another extension has the model provider ${id}`);
			replaced.set(id, models.getProvider(id));
			own.set(id, provider);
			models.setProvider(provider);
			added(id);
		},
		remove: (id, provider) => {
			if (own.get(id) !== provider) return;
			own.delete(id);
			const before = replaced.get(id);
			replaced.delete(id);
			if (before === undefined) models.deleteProvider(id);
			else models.setProvider(before);
		},
	};
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * An environment whose commands start without japa's keys (the environment variables its logins read), unless a
 * command is given one itself. Unset by the shell, so it holds on any computer.
 */
function withoutKeys(env: ExecutionEnv, keys: () => readonly string[]): ExecutionEnv {
	const exec = (command: string, options: ShellExecOptions | undefined, context: Context) => {
		const names = keys().filter((name) => NAME.test(name) && options?.env?.[name] === undefined);
		return env.exec(names.length === 0 ? command : `unset ${names.join(" ")}; ${command}`, options, context);
	};
	return new Proxy(env, {
		get(target, key) {
			if (key === "exec") return exec;
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The agent's computer: of the environments that are on, the one turned on last. */
export class Computers {
	private readonly stack: Array<{ env: ExecutionEnv; used: ExecutionEnv }> = [];
	private readonly keys: () => readonly string[];

	constructor(keys: () => readonly string[]) {
		this.keys = keys;
	}

	current(): ExecutionEnv | undefined {
		return this.stack.at(-1)?.used;
	}

	owner(): Owner<ExecutionEnv> {
		return {
			add: (_id, env) => void this.stack.push({ env, used: withoutKeys(env, this.keys) }),
			remove: (_id, env) => {
				const at = this.stack.findIndex((each) => each.env === env);
				if (at !== -1) this.stack.splice(at, 1);
			},
			needed: (env) => (this.stack.length === 1 && this.stack[0]?.env === env ? "It's my only computer: turn another one on first." : undefined),
		};
	}
}

/** Messaging channels: each opened with its platform's Inbox (the allowlist gate) and the UI, and shown cards while open. */
export function channelOwner(ui: UI, inbox: (platform: string) => Inbox): Owner<Channel> {
	const open = new Map<string, Channel>();
	return {
		add: async (platform, channel) => {
			if (open.has(platform)) throw new Error(`a ${platform} channel is already open`);
			await channel.open({ inbox: inbox(platform), ui });
			open.set(platform, channel);
			ui.attach({ channel: platform, show: (card, replace) => channel.show(card, replace) });
		},
		remove: async (platform, channel) => {
			if (open.get(platform) !== channel) return;
			open.delete(platform);
			ui.detach(platform);
			await channel.close();
		},
		needed: (channel) => (open.get(channel.platform) === channel && open.size === 1 ? "It's the only channel you can reach me on: turn another one on first." : undefined),
	};
}
