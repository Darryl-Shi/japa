// The agent's own computer: Pi's bash/read/write/edit, acting on whichever backend is the workbench. Generic — it
// knows nothing about the provider behind it.
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { computerExtension } from "./computer.ts";
import type { Host, JarvisExtension } from "./extension.ts";

export function shellExtension(): Extension {
	return defineExtension({
		name: "jarvis.shell",
		sections: [
			section(
				"computer",
				(input) =>
					`You have your own Linux computer (no access to the user's accounts or secrets). bash, read, write and edit act on it directly. Working directory: ${input.env?.cwd ?? "~"}. Anything that takes more than a couple of minutes belongs in a delegated task, not this conversation.`,
			),
		],
		tools: [createBashTool(), createReadTool(), createWriteTool(), createEditTool()],
	});
}

/** The workbench as two extensions: its shell and files, and its screen. None without a workbench. */
export function workbenchExtensions(host: Pick<Host, "workbench">, options: { screen: boolean }): JarvisExtension[] {
	const workbench = host.workbench;
	if (workbench === undefined) return [];
	const shell = shellExtension();
	const screen = computerExtension({ backend: workbench });
	return [
		{
			name: "computer",
			title: "Computer",
			about: "Shell and files on its own machine, which holds none of your secrets. It starts when needed and sleeps when idle.",
			safeTools: ["read"],
			chief: [shell],
			jobs: [shell],
		},
		{ name: "screen", title: "Screen", about: "Seeing and using the machine's desktop.", enabledByDefault: options.screen, chief: [screen], jobs: [screen] },
	];
}
