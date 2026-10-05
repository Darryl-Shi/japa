// A backend is a computer the agent works on: the core's adapter for infrastructure. Everything the agent does on a
// machine (shell, files, screen, coding agents) is built on this contract and never knows which provider is behind
// it. A provider is an extension that declares an OpenBackend under its name (`backends`); settings pick one by that
// name in machines.workbench. It only has to run commands: files and the screen are built on exec.

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

export interface Backend {
	/** Stable identity: equal ids see the same files at the same paths. */
	readonly id: string;
	/** The default working directory. */
	readonly home: string;
	/** Run a shell command (bash). The only required capability: everything else is built on it. */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	/** A link a human can open to watch or take over the machine's screen. */
	viewUrl?(): Promise<string>;
}

/**
 * How a provider opens the machine for a role (e.g. "workbench") from that role's settings, which are the provider's
 * own options. Opening starts nothing: the first command that needs the machine does.
 */
export type OpenBackend = (role: string, config: Readonly<Record<string, unknown>>) => Backend;

/** Single-quote for POSIX shells. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
