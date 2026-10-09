// The `google_request` tool: any Google REST call the other tools don't cover, limited to Google's API hosts so the
// bearer token goes nowhere else (spec §4.4).
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "../../src/sdk.ts";
import type { Api } from "./api.ts";

export const requestParameters = Type.Object({
  method: StringEnum(["GET", "POST", "PATCH", "PUT", "DELETE"] as const),
  url: Type.String({ description: "https://<service>.googleapis.com/…" }),
  query: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), {
      description: "query parameters; a list repeats the parameter",
    }),
  ),
  body: Type.Optional(Type.Unknown({ description: "JSON body" })),
});

export type RequestArgs = Static<typeof requestParameters>;

export const REQUEST_DESCRIPTION =
  "Any Google REST call the gmail, drive, calendar, contacts and tasks tools don't cover, as the user: " +
  "{ method, url, query?, body? }. The URL must be https://<service>.googleapis.com/…; replies with the HTTP " +
  "status and the response body.";

const NOT_GOOGLE = "Only https://*.googleapis.com URLs are allowed.";

const isGoogleApi = (url: string) => {
  const parsed = URL.parse(url);
  return parsed?.protocol === "https:" && parsed.hostname.endsWith(".googleapis.com");
};

export async function googleRequest(api: Api, { method, url, query, body }: RequestArgs): Promise<string> {
  if (!isGoogleApi(url)) return NOT_GOOGLE;
  const reply = await api.raw(method, url, { query, body });
  return `HTTP ${reply.status}\n${reply.body}`;
}
