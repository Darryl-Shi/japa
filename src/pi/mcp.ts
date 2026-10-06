// MCP servers (pi's registerMcpServer): each connected while its extension is on, its tools offered as that
// extension's own (mcp__<server>__<tool>, pi's names) and kept current as the server's list changes. A stdio server is
// started on the machine japa runs on, with only what it's given in its environment (never japa's keys); an HTTP server
// is reached at its URL. One that logs in with OAuth is an account (mcp:<server>): logged in to through /login like any
// other, its token refreshed by the core and sent with every request.
import { isAbsolute, resolve } from "node:path";
import type { ImageContent, OAuthCredential, TextContent, TSchema } from "@earendil-works/pi-ai";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthProtectedResourceMetadata,
	exchangeAuthorization,
	refreshAuthorization,
	registerClient,
	startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Account, ExtensionAPI, Loaded, McpServerConfig, Owner, ToolDefinition } from "./extension.ts";

/** pi's name for a server's tool. */
export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");

type Server = { config: McpServerConfig; from: Loaded; account?: Account; client?: Client };
type Parts = (TextContent | ImageContent)[];

const seconds = (config: McpServerConfig) => (config.timeout ?? 60) * 1000;
const http = (config: McpServerConfig) => config.url !== undefined && config.type !== "stdio";

/** A tool result's content, as the model takes it: text and images; anything else said in text. */
function partsOf(result: { content?: unknown; structuredContent?: unknown }): Parts {
	const content = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
	const parts = content.map((part): TextContent | ImageContent => {
		if (part.type === "text") return { type: "text", text: String(part.text) };
		if (part.type === "image") return { type: "image", data: String(part.data), mimeType: String(part.mimeType) };
		if (part.type === "resource") {
			const resource = part.resource as { uri?: string; text?: string; mimeType?: string };
			return { type: "text", text: resource.text ?? `[${resource.mimeType ?? "resource"}: ${resource.uri ?? ""}]` };
		}
		if (part.type === "resource_link") return { type: "text", text: `[${String(part.name ?? "resource")}: ${String(part.uri)}]` };
		return { type: "text", text: `[${String(part.type)} content]` };
	});
	if (parts.length === 0 && result.structuredContent !== undefined) return [{ type: "text", text: JSON.stringify(result.structuredContent) }];
	return parts;
}

/** An HTTP server's OAuth login, as an account: authorization code with PKCE, the code pasted back by the user. */
function oauthAccount(name: string, config: McpServerConfig & { url: string }): Account {
	const oauth = config.oauth ?? {};
	const redirectUrl = oauth.callbackUrl ?? `http://localhost${oauth.callbackPort === undefined ? "" : `:${oauth.callbackPort}`}/callback`;
	const resource = new URL(config.url);
	const authServerOf = async () => {
		try {
			return (await discoverOAuthProtectedResourceMetadata(config.url)).authorization_servers?.[0] ?? new URL("/", config.url).href;
		} catch {
			return new URL("/", config.url).href;
		}
	};
	const metadataOf = async (authServer: string) =>
		oauth.authServerMetadataUrl === undefined ? await discoverAuthorizationServerMetadata(authServer) : ((await (await fetch(oauth.authServerMetadataUrl)).json()) as Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>);
	const credentialOf = (tokens: OAuthTokens, authServer: string, client: OAuthClientInformationMixed, refresh = ""): OAuthCredential => ({
		type: "oauth",
		access: tokens.access_token,
		refresh: tokens.refresh_token ?? refresh,
		expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		authServer,
		client,
	});
	return {
		id: `mcp:${name}`,
		name: `${name} (MCP)`,
		auth: {
			oauth: {
				name: `${name} (MCP)`,
				login: async (interaction) => {
					const authServer = await authServerOf();
					const metadata = await metadataOf(authServer);
					const client: OAuthClientInformationMixed =
						oauth.clientId !== undefined
							? { client_id: oauth.clientId, ...(oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret }) }
							: await registerClient(authServer, {
									...(metadata === undefined ? {} : { metadata }),
									clientMetadata: { client_name: oauth.clientName ?? "japa", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
									...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
								});
					const { authorizationUrl, codeVerifier } = await startAuthorization(authServer, { ...(metadata === undefined ? {} : { metadata }), clientInformation: client, redirectUrl, resource, ...(oauth.scope === undefined ? {} : { scope: oauth.scope }) });
					interaction.notify({ type: "auth_url", url: authorizationUrl.href, instructions: "Once you allow it, your browser goes to an address that may not load: that's expected." });
					const answer = await interaction.prompt({ type: "manual_code", message: "Send the address your browser went to (or the code in it) as a reply.", placeholder: `${redirectUrl}?code=…` });
					const code = /[?&]code=([^&#]+)/.exec(answer)?.[1];
					const tokens = await exchangeAuthorization(authServer, {
						...(metadata === undefined ? {} : { metadata }),
						clientInformation: client,
						authorizationCode: code === undefined ? answer.trim() : decodeURIComponent(code),
						codeVerifier,
						redirectUri: redirectUrl,
						resource,
					});
					return credentialOf(tokens, authServer, client);
				},
				refresh: async (credential) => {
					const authServer = String(credential.authServer);
					const client = credential.client as OAuthClientInformationMixed;
					const metadata = await metadataOf(authServer);
					const tokens = await refreshAuthorization(authServer, { ...(metadata === undefined ? {} : { metadata }), clientInformation: client, refreshToken: credential.refresh, resource });
					return credentialOf(tokens, authServer, client, credential.refresh);
				},
				toAuth: async (credential) => ({ headers: { Authorization: `Bearer ${credential.access}` } }),
			},
		},
	};
}

export class McpServers {
	private readonly servers = new Map<string, Server>();
	private readonly accounts: Owner<Account>;
	private readonly credentials: ExtensionAPI["accounts"];
	private readonly cwd: () => string | undefined;
	private readonly log: (line: string) => void;

	constructor(options: {
		/** Where its OAuth login goes (the accounts' owner), and its credentials come from. */
		accounts: Owner<Account>;
		credentials: ExtensionAPI["accounts"];
		/** Where a stdio server's relative cwd is from: the agent's home. */
		cwd: () => string | undefined;
		log: (line: string) => void;
	}) {
		this.accounts = options.accounts;
		this.credentials = options.credentials;
		this.cwd = options.cwd;
		this.log = options.log;
	}

	/** The servers of the extensions that are on (pi's getMcpServers). */
	configs(): Record<string, McpServerConfig> {
		return Object.fromEntries([...this.servers].map(([name, server]) => [name, server.config]));
	}

	owner(): Owner<McpServerConfig> {
		return {
			add: async (name, config, from) => {
				if (this.servers.has(name)) throw new Error(`another extension has the MCP server ${name}`);
				if (config.url === undefined && config.command === undefined) throw new Error("it has neither a command nor a url");
				const server: Server = { config, from };
				this.servers.set(name, server);
				if (config.enabled === false) return;
				if (http(config) && config.oauth !== undefined) {
					server.account = oauthAccount(name, config as McpServerConfig & { url: string });
					await this.accounts.add(server.account.id, server.account, from);
				}
				await this.connect(name, server);
			},
			remove: async (name, _config, from) => {
				const server = this.servers.get(name);
				if (server?.from !== from) return;
				this.servers.delete(name);
				if (from.mcpTools.delete(name)) from.rebuild();
				await server.client?.close().catch(() => {});
				if (server.account !== undefined) await this.accounts.remove(server.account.id, server.account, from);
			},
		};
	}

	private async connect(name: string, server: Server): Promise<void> {
		const { config } = server;
		const client = new Client({ name: "japa", version: "1.0.0" });
		const account = server.account;
		const transport = http(config)
			? new StreamableHTTPClientTransport(new URL(config.url!), {
					// Each request with the account's token as it is then (refreshed by the core when it needs it).
					fetch: async (url, init) => {
						const headers = new Headers(init?.headers);
						for (const [key, value] of Object.entries(config.headers ?? {})) headers.set(key, value);
						if (account !== undefined) for (const [key, value] of Object.entries((await this.credentials.get(account.id)).auth.headers ?? {})) if (value !== null) headers.set(key, value);
						return fetch(url, { ...init, headers });
					},
				})
			: new StdioClientTransport({
					command: config.command!,
					...(config.args === undefined ? {} : { args: config.args }),
					env: { ...getDefaultEnvironment(), ...config.env },
					...(this.cwdOf(config) === undefined ? {} : { cwd: this.cwdOf(config)! }),
					stderr: "ignore",
				});
		await client.connect(transport, { timeout: seconds(config) });
		server.client = client;
		client.setNotificationHandler(ToolListChangedNotificationSchema, () => void this.list(name, server).catch((error: unknown) => this.log(`mcp ${name}: ${String(error)}`)));
		await this.list(name, server);
	}

	private cwdOf(config: McpServerConfig): string | undefined {
		if (config.cwd === undefined) return this.cwd();
		if (isAbsolute(config.cwd)) return config.cwd;
		const home = this.cwd();
		return home === undefined ? undefined : resolve(home, config.cwd);
	}

	/** Its tools, now: as its extension's, from agents' next request. */
	private async list(name: string, server: Server): Promise<void> {
		const client = server.client;
		if (client === undefined || this.servers.get(name) !== server) return;
		const listed = [];
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: seconds(server.config) });
			listed.push(...page.tools);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		const exposure = (tool: string) => server.config.toolExposure?.[tool] ?? server.config.exposure;
		const tools = listed.map(
			(tool): ToolDefinition => ({
				name: mcpToolName(name, tool.name),
				label: tool.title ?? tool.annotations?.title ?? tool.name,
				description: tool.description ?? tool.name,
				parameters: tool.inputSchema as unknown as TSchema,
				...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
				...(exposure(tool.name) === "hidden" ? { defaultActive: false } : {}),
				execute: async (_id, params, signal) => {
					const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined, { timeout: seconds(server.config), ...(signal === undefined ? {} : { signal }) });
					return { content: partsOf(result as { content?: unknown; structuredContent?: unknown }), ...(result.isError === true ? { isError: true } : {}) };
				},
			}),
		);
		server.from.mcpTools.set(name, tools);
		server.from.rebuild();
	}
}
