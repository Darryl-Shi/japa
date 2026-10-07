import type { Extension } from "japa/core";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

// Pass this entire file to extension_install("weather", source). No API key needed.
export default {
  name: "weather",
  register(_host) {
    return defineExtension({
      name: "weather",
      tools: [
        defineTool({
          name: "weather",
          description:
            "Get current weather by latitude and longitude (Open-Meteo).",
          parameters: Type.Object({
            latitude: Type.Number({ minimum: -90, maximum: 90 }),
            longitude: Type.Number({ minimum: -180, maximum: 180 }),
          }),
          replay: "safe", // Read-only request; retry may return fresher weather.
          async execute({ latitude, longitude }, _api, context) {
            const url = new URL("https://api.open-meteo.com/v1/forecast");
            url.search = new URLSearchParams({
              latitude: String(latitude),
              longitude: String(longitude),
              current: "temperature_2m,weather_code,wind_speed_10m",
            }).toString();
            const timeout = AbortSignal.timeout(10_000);
            const signal = context.abortSignal
              ? AbortSignal.any([context.abortSignal, timeout])
              : timeout;
            const response = await fetch(url, { signal });
            if (!response.ok)
              throw new Error(`Weather service returned ${response.status}`);
            return {
              content: [
                { type: "text", text: JSON.stringify(await response.json()) },
              ],
            };
          },
        }),
      ],
    });
  },
} satisfies Extension;

// Loader runs this without making a network request. Add extension-specific checks here.
export function selfTest(): void {
  if (!new URL("https://api.open-meteo.com/v1/forecast").hostname)
    throw new Error("Invalid endpoint");
}
