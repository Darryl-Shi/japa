// A backend is a computer the agent works on. It is the one abstraction over infrastructure: everything the agent
// does on a machine (shell, files, screen, coding agents, skill scripts) is a generic extension built on this
// contract, and never knows which provider is behind it. Providers (boat, local, anyone's own infra) implement it.

export type ExecOptions = {
	/** Absolute path, or relative to `home`. */
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	/** Combined stdout and stderr as it arrives. */
	onOutput?: (chunk: string) => void;
	signal?: AbortSignal;
};

export type ExecResult = { exitCode: number; timedOut?: boolean };

export type ScreenAction =
	| { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }
	| { type: "move"; x: number; y: number }
	| { type: "drag"; fromX: number; fromY: number; toX: number; toY: number }
	| { type: "type"; text: string }
	| { type: "key"; keys: string }
	| { type: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; amount?: number };

export interface Screen {
	screenshot(signal?: AbortSignal): Promise<{ png: Uint8Array; width: number; height: number }>;
	act(action: ScreenAction, signal?: AbortSignal): Promise<void>;
}

export interface Backend {
	/** Stable identity: equal ids see the same files at the same paths. */
	readonly id: string;
	/** The default working directory. */
	readonly home: string;
	/** Run a shell command (bash). The only required capability: everything else can be built on it. */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	/** Optional fast paths; when absent, files move through exec. */
	readFile?(path: string, signal?: AbortSignal): Promise<Uint8Array>;
	writeFile?(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void>;
	/** A native screen API, when the provider has one; otherwise the screen is driven through exec. */
	readonly screen?: Screen;
	/** A link a human can open to watch or take over the machine's screen. */
	viewUrl?(): Promise<string>;
	/** Stop billing while unused; the next exec brings it back. */
	suspend?(): Promise<void>;
}

/** A source of backends. Built-in providers and extensions register one under a name settings can refer to. */
export interface BackendProvider {
	readonly name: string;
	/** `role` is what the backend is for (e.g. "workbench", "desk"); `config` comes from settings. */
	open(role: string, config: Readonly<Record<string, unknown>>): Promise<Backend>;
}

export class BackendProviders {
	private readonly providers = new Map<string, BackendProvider>();

	register(provider: BackendProvider): void {
		this.providers.set(provider.name, provider);
	}

	async open(role: string, config: Readonly<Record<string, unknown>> & { provider: string }): Promise<Backend> {
		const provider = this.providers.get(config.provider);
		if (provider === undefined) throw new Error(`No backend provider "${config.provider}" (have: ${[...this.providers.keys()].join(", ") || "none"})`);
		return provider.open(role, config);
	}
}

/** Single-quote for POSIX shells. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
