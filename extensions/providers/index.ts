import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { defineJapaExtension } from "../../src/sdk.ts";

export default defineJapaExtension({
  name: "providers",
  summary: "Makes pi-ai's built-in model providers available, with API keys from the secrets store or environment variables",
  provides: { provider: builtinProviders() },
});
