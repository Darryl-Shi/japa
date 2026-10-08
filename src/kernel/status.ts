import type { Status } from "./contracts.ts";

/** What `japa status` prints and `/status` shows. */
export function statusText(s: Status): string {
  const lines = [`model: ${s.model ? `${s.model.provider}/${s.model.modelId}` : "none"}`, "extensions:"];
  for (const e of s.extensions) {
    const state = e.state === undefined || e.state === "on" ? "" : ` (${e.state})`;
    lines.push(`  ${e.name} — ${e.summary}${state}`);
    if (e.status !== undefined) lines.push(`    ${e.status}`);
  }
  if (s.errors.length > 0) lines.push("errors:");
  for (const e of s.errors) lines.push(`  ${e.name}: ${e.error}`);
  return lines.join("\n");
}
