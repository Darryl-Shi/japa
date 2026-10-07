import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "../core/host.ts";
import { createLoader, MAX_SOURCE_LENGTH } from "../core/loader.ts";

const guide = `Write a single TypeScript file and call extension_install(name, source).
Names are lowercase slugs, 1–64 characters. Source is at most ${MAX_SOURCE_LENGTH} characters.
The catalog is capped at 32 extensions and 16 revisions per extension; old replay receipts are never
silently pruned. At these limits, operator maintenance is required. Catalog text is capped at 32,000 characters.
Example:
import type { Extension } from "japa/core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
export default {
  name: "hello",
  register(host) {
    return { name: "hello", tools: [defineTool({
      name: "hello", description: "Say hello", parameters: Type.Object({}), replay: "safe",
      execute: async () => ({ content: [{ type: "text", text: "Hello" }] })
    })] };
  }
} satisfies Extension;

register(host) must be synchronous and side-effect-free: declare native tools, sections,
hooks or wraps; capture host for later use, but do not access live resources during registration.
No generated custom durable tasks in v1. Adapter implementations and lifecycle changes require
restart and normal host composition; they cannot be hot-installed. Packaged extensions cannot
be replaced. Only japa, japa/core, @earendil-works/* and Node built-in imports are supported;
there is no dependency installation or relative-file import support.

Event-driven integrations may import wakeChiefOfStaff or scheduleWake from "japa".
Call wakeChiefOfStaff(host, { address: { channel, recipient }, reason, notify: false }, stableKey, context)
from execution, never registration. scheduleWake takes the same request plus at (epoch milliseconds).
Use stable event keys for deduplication; retain the originating address. Wakes are one-shot and silent
by default. The chief of staff decides what to do and whether to notify. Do not create your own timer engine.

The host typechecks, bundles, probes in a timeout-limited child, then activates. Optional exported
selfTest() runs in the child. Keep top-level code pure. This is trusted code with full host privileges,
NOT a sandbox. Probe success does not prove runtime correctness. New calls use new code; in-flight
calls keep old code. Durable tool effects need stable idempotency keys before declaring replay safe.
Identical name/source installs are receipts, not rollback commands, even after newer installs.
Startup quarantines interrupted activation and restores previous code when available. It does NOT
undo state migrations or external effects. Runtime errors do not trigger automatic rollback.
Self tools are selected for workers only; root must explicitly omit japa.self. Install japa.self
before the ingress/assistant extension so restore completes before accepting inputs.
Safe boot skips restoration but retains these tools. Catalog active=null means the code is not loaded.
Replaying accepted source is a receipt, not an activation command; edit it to install another revision.`;

function text(value: unknown) {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return {
    content: [
      {
        type: "text" as const,
        text:
          content.length > 32_000
            ? content.slice(0, 32_000) + "\n[Catalog truncated]"
            : content,
      },
    ],
  };
}

/** Select on workers, not root. Put before ingress extensions in HostOptions.extensions. */
export function selfExtension(
  directory: string,
  options: { safe?: boolean } = {},
): Extension {
  let loader: ReturnType<typeof createLoader>;
  return {
    name: "japa.self",
    register(host) {
      loader = createLoader(host, directory);
      return defineExtension({
        name: "japa.self",
        tools: [
          defineTool({
            name: "extension_install",
            description:
              "Build, check and hot-install a trusted single-file extension. Read extension_guide first.",
            parameters: Type.Object({
              name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
              source: Type.String({
                minLength: 1,
                maxLength: MAX_SOURCE_LENGTH,
              }),
            }),
            replay: "safe",
            async execute({ name, source }, _api, context) {
              try {
                return text(await loader.install(name, source, context));
              } catch (error) {
                context.abortSignal?.throwIfAborted();
                const message = String(
                  error instanceof Error ? error.message : error,
                ).slice(-8192);
                return {
                  ...text(message),
                  isError: true,
                  diagnostics: [{ severity: "error" as const, message }],
                };
              }
            },
          }),
          defineTool({
            name: "extension_catalog",
            description:
              "List generated extension hashes, source paths, status and diagnostics.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, _api, context) =>
              text(await loader.list(context)),
          }),
          defineTool({
            name: "extension_guide",
            description:
              "Read the extension API, example and operational limitations.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async () => text(guide),
          }),
        ],
      });
    },
    async start() {
      if (!options.safe) await loader.restore(BACKGROUND_CONTEXT);
    },
  };
}
