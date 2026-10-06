// The agent's computer: Pi's bash/read/write/edit, acting through the environment in use (an extension registers it;
// the built-in one is the machine japa runs on). Part of the core; which computer it is, is the environment's.
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { shellQuote } from "../core/shell.ts";
import type { ExecOptions, ExecResult, ExtensionFactory } from "./extension.ts";

/** The machine japa runs on, as an environment: its files are japa's own machine's (FileSystem ids say so). */
const HERE = new NodeExecutionEnv({ cwd: import.meta.dirname }).id;

/** The built-in computer: this machine, from `home` (the home directory of the user japa runs as). */
export const localComputer =
	(home: string): ExtensionFactory =>
	(pi) =>
		pi.registerEnvironment(new NodeExecutionEnv({ cwd: home, shellEnv: { HOME: home } }));

/** `own`: where japa's own code and data are, on the machine it runs on: it never changes them, and doesn't read its data. */
export function computerExtension(own: { code: string; data: string }): Extension {
	return defineExtension({
		name: "computer",
		sections: [
			section("computer", (input) => {
				if (input.env === undefined) return undefined;
				const here = input.env.id === HERE;
				return [
					`You have your own computer${here ? ": the one you run on" : ""}. bash, read, write and edit act on it directly. Working directory: ${input.env.cwd}.`,
					here ? `Your own code (${own.code}) and data (${own.data}) are on it too: never change them, and leave your data alone (it holds your keys); you change yourself as the extending-japa skill says.` : "",
				]
					.filter(Boolean)
					.join(" ");
			}),
		],
		tools: [createBashTool(), createReadTool(), createWriteTool(), createEditTool()],
	});
}

/** pi's exec on a computer: one program and its arguments, from its home unless `cwd` says; stdout and stderr apart. */
export async function execOn(env: ExecutionEnv | undefined, command: string, args: readonly string[], options: ExecOptions, context: Context): Promise<ExecResult> {
	if (env === undefined) return { stdout: "", stderr: "there's no computer: no environment is on", code: 1, killed: false };
	const within = options.signal === undefined ? context : withAbortSignal(options.signal, context);
	const errors = await env.createTempFile({ prefix: "exec-", suffix: ".err" }, within);
	if (!errors.ok) return { stdout: "", stderr: errors.error.message, code: 1, killed: false };
	let stdout = "";
	const line = `${[command, ...args].map(shellQuote).join(" ")} 2>${shellQuote(errors.value)}`;
	const result = await env.exec(line, { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.timeout === undefined ? {} : { timeout: options.timeout / 1000 }), onOutput: (text) => void (stdout += text) }, within);
	const read = await env.readTextFile(errors.value, context);
	await env.remove(errors.value, { force: true }, context);
	const stderr = read.ok ? read.value : "";
	if (!result.ok) return { stdout, stderr: stderr || result.error.message, code: 1, killed: result.error.code === "timeout" || result.error.code === "aborted" };
	return { stdout, stderr, code: result.value.exitCode, killed: false };
}
