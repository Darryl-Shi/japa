// An MCP server over stdio for the tests: one tool, echo, that says back what it's given and where it runs.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Say it back.",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
	],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
	content: [{ type: "text", text: `echo: ${String(request.params.arguments?.text)} (secret: ${process.env.JAPA_TEST_SECRET ?? "none"})` }],
}));
await server.connect(new StdioServerTransport());
