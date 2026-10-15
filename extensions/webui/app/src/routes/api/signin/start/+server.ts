import type { RequestHandler } from "./$types";
import type { FlowStart } from "$lib/protocol";
import { jsonError, NAME, readJsonObject, text, withSettings } from "$lib/server/http";

/** The body as a FlowStart; undefined when it isn't one. An API key goes only to the flow, never into a reply. */
function flowStart(body: Record<string, unknown>): FlowStart | undefined {
  if (body.kind === "extension") {
    return typeof body.extension === "string" && NAME.test(body.extension)
      ? { kind: "extension", extension: body.extension }
      : undefined;
  }
  if (body.kind !== "provider" || typeof body.provider !== "string" || !NAME.test(body.provider)) return undefined;
  if (body.method !== "oauth" && body.method !== "api_key") return undefined;
  if (body.key === undefined) return { kind: "provider", provider: body.provider, method: body.method };
  const key = text(body.key, 16_384);
  if (key === undefined || body.method !== "api_key") return undefined;
  return { kind: "provider", provider: body.provider, method: body.method, key };
}

// 409 when a sign-in to the same provider or extension runs.
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const start = flowStart(body);
  if (start === undefined) return jsonError(400, "Invalid sign-in");
  return withSettings(locals, (s) => s.startFlow(start), 409);
};
