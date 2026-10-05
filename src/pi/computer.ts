// The agent's computer, which is the machine it runs on: Pi's bash/read/write/edit there.
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { JapaExtension } from "./extension.ts";

/** `own`: where its own code and data are on this machine, which it changes only through install_extension. */
export function computerExtension(own: readonly string[]): JapaExtension {
	return {
		...defineExtension({
			name: "computer",
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
		}),
		title: "Computer",
		about: "Shell and files on the machine it runs on.",
		// They only touch files on its own computer.
		safeTools: ["read", "write", "edit"],
	};
}
