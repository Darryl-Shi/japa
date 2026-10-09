import type { ModelRef } from "@earendil-works/pi-durable";
import type { JapaExtension } from "./extension.ts";
import type { Settings } from "./settings.ts";

const ref = (m: ModelRef | undefined) => (m ? `${m.provider}/${m.modelId}` : "same as cos");

/** The CoS's capabilities section: extensions, configured models and surfaces. */
export function capabilities(input: { extensions: JapaExtension[]; models: Settings["models"] }): string {
  const { extensions, models } = input;
  const names = (contract: string) =>
    extensions.flatMap((e) => ((e.provides?.[contract] ?? []) as { name: string }[]).map((c) => c.name));
  return [
    "Extensions:",
    ...extensions.map((e) => `- ${e.name}: ${e.summary}`),
    `Models: cos ${ref(models.cos)}, worker ${ref(models.worker)}, consolidation ${ref(models.consolidation)}`,
    `Surfaces: ${[...names("surface"), ...names("messaging")].join(", ")}`,
  ].join("\n");
}
