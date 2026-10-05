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
import { SecretsFile } from "../src/credentials.ts";
import { type Japa, startJapa } from "../src/japa.ts";
import type { Host, JapaExtension } from "../src/pi/extension.ts";
import { SettingsFile } from "../src/settings.ts";

export const context = BACKGROUND_CONTEXT;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
export const say = (text: string) => fauxAssistantMessage(text);
export const target = (messageId: number) => ({ channel: "test", chatId: "1", messageId: String(messageId) });

/** One model request: who it's from (the chief of staff, a job, or a background call) and the newest message it answers. */
export type Turn = { text: string; job?: string; request: string };

function lastText(request: PiContext): string {
	const last = [...request.messages].reverse().find((message) => message.role === "user" || message.role === "toolResult");
	if (last === undefined) return "";
	return typeof last.content === "string" ? last.content : last.content.map((part) => ("text" in part ? part.text : "")).join("");
}

export async function agent(options: {
	extensions: (host: Host) => JapaExtension[];
	script: (turn: Turn) => AssistantMessage | Promise<AssistantMessage>;
	/** A machine, provided the way any is: an extension declaring a backend, named in machines.workbench. */
	workbench?: Backend;
	settings?: Parameters<SettingsFile["update"]>[0];
	/** Reuse one (a restart); default: a new one. */
	dataDir?: string;
}) {
	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "japa-")));
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-fast" }] });
	const models = createModels();
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
		...(options.workbench === undefined ? {} : { machines: { workbench: { provider: "test-machine" } } }),
		...options.settings,
	});
	const secrets = new SecretsFile(join(dataDir, "secrets.json"));
	const cards: Array<{ card: Card; replaced?: CardRef; ref: CardRef }> = [];
	let shown = 5000;
	const japa: Japa = await startJapa(
		{
			dataDir,
			settings,
			secrets,
			models,
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
								const ref = replace ?? { channel: "test", chatId: "7", messageId: String(shown++) };
								cards.push({ card, ref, ...(replace === undefined ? {} : { replaced: replace }) });
								return ref;
							},
						}),
				},
				...(options.workbench === undefined ? [] : [{ name: "test-machine", title: "Test machine", about: "", backends: { "test-machine": () => options.workbench! } }]),
				...options.extensions(host),
			],
		},
		context,
	);
	const until = async (check: () => boolean, what: string) => {
		for (let i = 0; i < 500 && !check(); i++) await sleep(10);
		assert.ok(check(), `timed out waiting for ${what}`);
	};
	const inbox = japa.host.inbox("test");
	return {
		japa,
		thread: japa.thread,
		host: japa.host,
		settings,
		secrets,
		turns,
		cards,
		dataDir,
		until,
		/** A message from the user on the test channel. */
		ask: (id: string, text: string, messageId = 1, arrival?: Parameters<typeof inbox.ask>[5]) => inbox.ask(7, id, text, target(messageId), context, arrival),
		done: async () => {
			await japa.close(context);
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}
