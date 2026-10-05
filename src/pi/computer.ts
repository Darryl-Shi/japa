// The agent's computer, which is the machine it runs on: Pi's bash/read/write/edit there. Part of the core.
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

/** `own`: where its own code and data are on this machine: it never changes them, and doesn't read its data. */
export function computerExtension(own: { code: string; data: string }): Extension {
	return defineExtension({
		name: "computer",
		sections: [
			section(
				"computer",
				(input) =>
					input.env === undefined
						? undefined
						: `You have your own computer: the one you run on. bash, read, write and edit act on it directly. Working directory: ${input.env.cwd}. Your own code (${own.code}) and data (${own.data}) are on it too: never change them, and leave your data alone (it holds your keys); you change yourself as the extending-japa skill says.`,
			),
		],
		tools: [createBashTool(), createReadTool(), createWriteTool(), createEditTool()],
	});
}
