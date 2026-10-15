import { randomUUID } from "node:crypto";
import type { InputSource, Origin } from "./contracts.ts";

/** `surface:<surface>:<chat>:<id>`, each part URI-encoded; `id` defaults to a fresh UUID. */
export function requestIdFor(origin: { surface: string; chat?: string; id?: string }): string {
  const parts = [origin.surface, origin.chat ?? "", origin.id ?? randomUUID()];
  return `surface:${parts.map(encodeURIComponent).join(":")}`;
}

/** Where an input came from: its surface and chat, `"proactive"` for kernel inputs, the gateway when it has no requestId. */
export function originOf(requestId: string | undefined): Origin {
  if (requestId === undefined) return { surface: "gateway" };
  const match = /^surface:([^:]*):([^:]*):/.exec(requestId);
  if (!match) return "proactive";
  const surface = decodeURIComponent(match[1]!);
  return match[2] ? { surface, chat: decodeURIComponent(match[2]) } : { surface };
}

const JOB_STATUSES = ["queued", "running", "needs_input", "done", "failed", "cancelled"];

/**
 * The source of a root input, from its submission's requestId and its text (see `InputSource`): `surface:…` or no
 * requestId is a person's; `report:<jobId>:<seq>[:<attempt>]` whose text starts with the header `reportText` wrote
 * (`[job <id> "<title>" <status>] `) is a job report; anything else the kernel posted is a note. Only kernel inputs'
 * text is parsed: a person's never is.
 */
export function sourceOf(requestId: string | undefined, text: string): InputSource {
  const origin = originOf(requestId);
  if (origin !== "proactive") return { type: "person", ...origin };
  const id = requestId!;
  if (id.startsWith("report:")) return reportSource(id.split(":")[1]!, text) ?? { type: "note" };
  if (id.startsWith("trigger:")) return { type: "note", from: id.split(":")[1]! };
  return { type: "note" };
}

/** Parses `[job <jobId> "<title>" <status>] <text>` (the job id from the requestId); the title may hold quotes and brackets. */
function reportSource(jobId: string, text: string): InputSource | undefined {
  const prefix = `[job ${jobId} "`;
  if (jobId === "" || !text.startsWith(prefix)) return undefined;
  // The title ends at the first `" <status>]` followed by a space or the end of the text.
  const header = new RegExp(`" (${JOB_STATUSES.join("|")})\\](?: |$)`, "g");
  header.lastIndex = prefix.length;
  const match = header.exec(text);
  if (match === null) return undefined;
  const title = text.slice(prefix.length, match.index);
  return { type: "job_report", jobId, title, status: match[1]!, text: text.slice(match.index + match[0].length) };
}
