// The agent's computer, which is the machine it runs on: Pi's bash/read/write/edit, and its screen.
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { computerExtension } from "./computer.ts";
import type { JapaExtension } from "./extension.ts";

/** `own`: where its own code and data are on this machine, which it changes only through install_extension. */
export function shellExtension(own: readonly string[]): Extension {
	return defineExtension({
		name: "jarvis.shell",
		sections: [
			section(
				"computer",
				(input) =>
					input.env === undefined
						? undefined
						: `You have your own Linux computer: the one you run on. bash, read, write and edit act on it directly. Working directory: ${input.env.cwd}. Your own code and data are on it too (${own.join(", ")}): leave them alone; you change yourself only with install_extension. Use it yourself only for a quick command or two; real work on it is a job.`,
			),
		],
		tools: [createBashTool(), createReadTool(), createWriteTool(), createEditTool()],
	});
}

/** The computer as two extensions: its shell and files, and its screen (on by default when it has a display). */
export function computerExtensions(options: { own: readonly string[]; display: string; hasDisplay: boolean }): JapaExtension[] {
	const shell = shellExtension(options.own);
	const screen = computerExtension({ display: options.display });
	return [
		{
			name: "computer",
			title: "Computer",
			about: "Shell and files on the machine it runs on.",
			// They only touch files on its own computer.
			safeTools: ["read", "write", "edit"],
			chief: [shell],
			jobs: [shell],
		},
		{ name: "screen", title: "Screen", about: "Seeing and using the machine's desktop.", enabledByDefault: options.hasDisplay, chief: [screen], jobs: [screen] },
	];
}
