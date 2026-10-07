// Launched by recovery.test.ts. The parent kills this process after durable tool intent.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Host } from "../src/core/host.ts";
import { defaultExtensions } from "../src/defaults.ts";
import { receive } from "../src/extensions/messaging.ts";
import { textOf } from "../src/extensions/text.ts";
import { context, scriptedModels } from "./helpers.ts";

const [home, mode] = process.argv.slice(2) as [string, string];
await mkdir(join(home, "workspace"), { recursive: true });
let finish!: () => void;
const finished = new Promise<void>((resolve) => {
  finish = resolve;
});
const models = scriptedModels((request, _options, _state, model) => {
  const message = request.messages.findLast(
    (message) => message.role !== "system",
  )!;
  const call = (name: string, args: Record<string, string>) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  if (model.id === "worker")
    return message.role === "toolResult"
      ? fauxAssistantMessage("Worker complete")
      : call("crash_point", {});
  if (textOf(message) === "Start durable work")
    return call("job_start", {
      title: "Crash test",
      instructions: "Use crash_point",
    });
  return fauxAssistantMessage(
    textOf(message).startsWith("Background job update")
      ? "Recovered complete"
      : "Delegated",
  );
});
const host = await Host.open({
  storage: await openNodeSqliteStorage(join(home, "japa.sqlite")),
  extensions: [
    ...defaultExtensions({
      home,
      models,
      channel: {
        settings: {
          async prompt() {
            return undefined;
          },
          async notify() {},
        },
        async start() {
          return () => {};
        },
        async send(_address, message) {
          if (message.text === "Recovered complete") finish();
        },
      },
    }),
    {
      name: "crash-fixture",
      register: () => ({
        name: "crash-fixture",
        tools: [
          defineTool({
            name: "crash_point",
            description: "A restart-safe fixture",
            parameters: Type.Object({}),
            replay: "safe",
            async execute(_args, _api, context) {
              if (mode === "crash") {
                process.stdout.write("READY\n");
                await delay(60_000, undefined, { signal: context.abortSignal });
              }
              await writeFile(
                join(home, "workspace", "result.txt"),
                "one idempotent result",
              );
              return { content: [{ type: "text", text: "Saved result.txt" }] };
            },
          }),
        ],
      }),
    },
  ],
});
await receive(
  host,
  {
    id: "stable-ingress",
    address: { channel: "test", recipient: "owner" },
    text: "Start durable work",
  },
  context,
);
await finished;
const jobs = await host.adapters.jobs.list(context);
await host.close();
process.stdout.write(
  `RESULT ${JSON.stringify(jobs.map(({ id, status }) => ({ id, status })))}\n`,
);
