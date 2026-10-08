import type { ModelRef } from "@earendil-works/pi-durable";
import type { JapaExtension } from "./extension.ts";
import type { Settings } from "./settings.ts";
import type { WorkerProfile } from "./workers.ts";

const ref = (m: ModelRef | undefined) => (m ? `${m.provider}/${m.modelId}` : "same as cos");

/** The CoS's capabilities section: extensions, worker profiles, configured models and surfaces. */
export function capabilities(input: {
  extensions: JapaExtension[];
  profiles: ReadonlyMap<string, Pick<WorkerProfile, "name" | "description">>;
  models: Settings["models"];
}): string {
  const { extensions, profiles, models } = input;
  const names = (contract: string) =>
    extensions.flatMap((e) => ((e.provides?.[contract] ?? []) as { name: string }[]).map((c) => c.name));
  return [
    "Extensions:",
    ...extensions.map((e) => `- ${e.name}: ${e.summary}`),
    "Workers:",
    ...[...profiles.values()].map((p) => `- ${p.name}: ${p.description}`),
    `Models: cos ${ref(models.cos)}, worker ${ref(models.worker)}, consolidation ${ref(models.consolidation)}`,
    `Surfaces: ${[...names("surface"), ...names("messaging")].join(", ")}`,
  ].join("\n");
}
