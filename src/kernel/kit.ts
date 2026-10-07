import { MemoryStorage, type ModelRef } from "@earendil-works/pi-durable";
import { type FauxProviderHandle, fauxProvider, type RegisterFauxProviderOptions } from "@earendil-works/pi-ai";
import type { JapaExtension } from "./extension.ts";

/** A faux model provider and in-memory storage, packaged as the extension "test-kit", for tests and smoke loads. */
export function fauxKit(options?: RegisterFauxProviderOptions): {
  faux: FauxProviderHandle;
  extension: JapaExtension;
  model: ModelRef;
} {
  const faux = fauxProvider(options);
  const extension: JapaExtension = {
    name: "test-kit",
    summary: "Faux models and in-memory storage for tests",
    provides: {
      storage: [{ name: "memory", open: async () => new MemoryStorage() }],
      provider: [faux.provider],
    },
  };
  const { provider, id } = faux.getModel();
  return { faux, extension, model: { provider, modelId: id } };
}
