// A whole agent (core plus the given extensions) on pi-ai's faux provider, with a fake channel surface that records
// every card it's asked to show.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, JsonObject, Context as PiContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Backend } from "../src/core/backend.ts";
import type { Card, CardRef } from "../src/core/ui.ts";
import { FileCredentialStore, SecretsFile } from "../src/credentials.ts";
import { type Jarvis, startJarvis } from "../src/jarvis.ts";
import type { Host, JarvisExtension } from "../src/pi/extension.ts";
import { SettingsFile } from "../src/settings.ts";

export const context = BACKGROUND_CONTEXT;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
export const say = (text: string) => fauxAssistantMessage(text);
export const target = (messageId: number) => ({ chatId: 1, messageId, channel: "test" });

/** One model request: who it's from (the chief of staff, a job, or a background call) and the newest message it answers. */
export type Turn = { text: string; job?: string; request: string };

function lastText(request: PiContext): string {
	const last = [...request.messages].reverse().find((message) => message.role === "user" || message.role === "toolResult");
	if (last === undefined) return "";
	return typeof last.content === "string" ? last.content : last.content.map((part) => ("text" in part ? part.text : "")).join("");
}

export async function agent(options: {
	extensions: (host: Host) => JarvisExtension[];
	script: (turn: Turn) => AssistantMessage | Promise<AssistantMessage>;
	workbench?: Backend;
	settings?: Parameters<SettingsFile["update"]>[0];
	/** Reuse one (a restart); default: a new one. */
	dataDir?: string;
}) {
	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "jarvis-")));
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-fast" }] });
	const credentials = new FileCredentialStore(join(dataDir, "auth.json"));
	const models = createModels({ credentials });
	models.setProvider(faux.provider);
	const turns: Turn[] = [];
	const respond: FauxResponseFactory = async (request) => {
		const sent = JSON.stringify(request);
		if (sent.includes("You keep the working set")) return say(JSON.stringify({ working_set: "" }));
		const turn: Turn = { text: lastText(request), request: sent, ...(/Your job \(([\w.]+)\)/.exec(sent) === null ? {} : { job: /Your job \(([\w.]+)\)/.exec(sent)![1]! }) };
		turns.push(turn);
		return options.script(turn);
	};
	faux.setResponses(Array.from({ length: 300 }, () => respond));
	const settings = new SettingsFile(dataDir);
	settings.update({
		model: { provider: "faux", modelId: "faux-1" },
		delegateModel: { provider: "faux", modelId: "faux-1" },
		jobModels: { fast: { provider: "faux", modelId: "faux-fast" } },
		context: { idleMinutes: 60, sliceTokens: 1_000_000 },
		allowlist: { test: [7] },
		...options.settings,
	});
	const secrets = new SecretsFile(join(dataDir, "secrets.json"));
	const cards: Array<{ card: Card; replaced?: CardRef; ref: CardRef }> = [];
	let shown = 5000;
	const jarvis: Jarvis = await startJarvis(
		{
			dataDir,
			settings,
			secrets,
			models,
			credentials,
			...(options.workbench === undefined ? {} : { workbench: options.workbench }),
			extensions: (host) => [
				// A stand-in channel: shows cards by recording them.
				{
					name: "test-channel",
					title: "Test channel",
					about: "",
					channel: "test",
					start: () =>
						host.ui.attach({
							channel: "test",
							show: async (card, replace) => {
								const ref = replace ?? { channel: "test", chatId: 7, messageId: shown++ };
								cards.push({ card, ref, ...(replace === undefined ? {} : { replaced: replace }) });
								return ref;
							},
						}),
				},
				...options.extensions(host),
			],
		},
		context,
	);
	const until = async (check: () => boolean, what: string) => {
		for (let i = 0; i < 500 && !check(); i++) await sleep(10);
		assert.ok(check(), `timed out waiting for ${what}`);
	};
	const inbox = jarvis.host.inbox("test");
	return {
		jarvis,
		thread: jarvis.thread,
		host: jarvis.host,
		settings,
		secrets,
		turns,
		cards,
		dataDir,
		until,
		/** A message from the user on the test channel. */
		ask: (id: string, text: string, messageId = 1, arrival?: Parameters<typeof inbox.ask>[5]) => inbox.ask(7, id, text, target(messageId), context, arrival),
		done: async () => {
			await jarvis.close(context);
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}
