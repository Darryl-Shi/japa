import type { Settings } from "../settings.ts";

/** Whether the CoS's live window should be consolidated: it is idle, and either full or stale. */
export function shouldConsolidate(
  { busy, windowTokens, lastUserAt, now }: { busy: boolean; windowTokens: number; lastUserAt?: number; now: number },
  limits: Settings["context"],
): boolean {
  const stale = lastUserAt !== undefined && now - lastUserAt > limits.idleResetHours * 3_600_000;
  return !busy && windowTokens > 0 && (windowTokens > limits.resetTokens || stale);
}
