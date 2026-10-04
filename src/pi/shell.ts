// The agent's own computer: Pi's bash/read/write/edit, acting on whichever backend is the workbench. Generic — it
// knows nothing about the provider behind it.
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

export function shellExtension(): Extension {
	return defineExtension({
		name: "jarvis.shell",
		sections: [
			section(
				"computer",
				(input) =>
					`You have your own Linux computer (no access to Darryl's accounts or secrets). bash, read, write and edit act on it directly. Working directory: ${input.env?.cwd ?? "~"}. Anything that takes more than a couple of minutes belongs in a delegated task, not this conversation.`,
			),
		],
		tools: [createBashTool(), createReadTool(), createWriteTool(), createEditTool()],
	});
}
