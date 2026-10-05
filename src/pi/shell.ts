// The agent's own computer: Pi's bash/read/write/edit, acting on whichever backend is the workbench. Generic — it
// knows nothing about the provider behind it.
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { computerExtension } from "./computer.ts";
import type { Host, JapaExtension } from "./extension.ts";

export function shellExtension(): Extension {
	return defineExtension({
		name: "jarvis.shell",
		sections: [
			section(
				"computer",
				(input) =>
					input.env === undefined
						? undefined
						: `You have your own Linux computer (no access to the user's accounts or secrets), separate from where you run: nothing you write there changes you. bash, read, write and edit act on it directly. Working directory: ${input.env?.cwd ?? "~"}. Use it yourself only for a quick command or two; real work on it is a job.`,
			),
		],
		tools: [createBashTool(), createReadTool(), createWriteTool(), createEditTool()],
	});
}

/** The workbench as two extensions: its shell and files, and its screen. Both say nothing while there's no workbench. */
export function workbenchExtensions(host: Pick<Host, "workbench">, options: { screen: boolean }): JapaExtension[] {
	const shell = shellExtension();
	const screen = computerExtension({ backend: () => host.workbench() });
	return [
		{
			name: "computer",
			title: "Computer",
			about: "Shell and files on its own machine, which holds none of your secrets. It starts when needed and sleeps when idle.",
			// They only ever touch the workbench's own files: its sandbox, nothing of the user's.
			safeTools: ["read", "write", "edit"],
			chief: [shell],
			jobs: [shell],
		},
		{ name: "screen", title: "Screen", about: "Seeing and using the machine's desktop.", enabledByDefault: options.screen, chief: [screen], jobs: [screen] },
	];
}
