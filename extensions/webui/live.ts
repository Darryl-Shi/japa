// The live hub: one watch each on the root conversation, the jobs and the pending secret requests, fanned out to every
// open stream as a snapshot, then the smallest update per change.
import type { AgentEvent, EntryId } from "@earendil-works/pi-durable";
import type { InputSource, Job, SecretRequest, SurfaceContext } from "japa/sdk";
import type { JobView, LiveEvent, SecretRequestView, Snapshot } from "./app/src/lib/protocol.ts";
import { applyEvents, type Transcript } from "./transcript.ts";

export type Hub = {
  /** Sends a snapshot now, then every update; `close` when the hub closes. Returns unsubscribe. */
  subscribe(send: (e: LiveEvent) => void, close: () => void): () => void;
  snapshot(): Snapshot;
  /** Feeds a batch of root conversation events, with the sources of its user entries. */
  events(events: readonly AgentEvent[], sources?: ReadonlyMap<EntryId, InputSource>): void;
  jobs(jobs: Job[]): void;
  secrets(pending: SecretRequest[]): void;
  /** Closes every subscriber; later subscribers are closed at once. */
  close(): void;
};

export function jobView(j: Job): JobView {
  return {
    id: j.id,
    title: j.title,
    brief: j.brief,
    status: j.status,
    ...(j.progress !== undefined && { progress: j.progress }),
    ...(j.result !== undefined && { result: j.result }),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

export const secretView = (r: SecretRequest): SecretRequestView => ({ id: r.id, name: r.name, why: r.why, at: r.at });

/** The updates that take `before` to `after`, `snapshot` naming whether the batch re-read the conversation. */
export function transcriptUpdates(before: Transcript, after: Transcript, snapshot: boolean): LiveEvent[] {
  const { lines, streaming, busy } = after;
  const appended = before.lines.length <= lines.length && before.lines.every((l, i) => lines[i] === l);
  if (snapshot || !appended) return [{ type: "transcript", lines, streaming, busy }];
  const updates: LiveEvent[] = [];
  if (lines.length > before.lines.length) updates.push({ type: "lines", lines: lines.slice(before.lines.length) });
  if (streaming !== before.streaming) {
    const extended = streaming.startsWith(before.streaming);
    updates.push(
      extended ? { type: "delta", text: streaming.slice(before.streaming.length) } : { type: "streaming", text: streaming },
    );
  }
  if (busy !== before.busy) updates.push({ type: "busy", busy });
  return updates;
}

export function createHub(): Hub {
  let state: Snapshot = { lines: [], streaming: "", busy: false, jobs: [], secrets: [], connected: false };
  const subscribers = new Map<(e: LiveEvent) => void, () => void>();
  let closed = false;

  const broadcast = (updates: LiveEvent[]) => {
    for (const e of updates) {
      for (const [send, close] of subscribers) {
        try {
          send(e);
        } catch {
          subscribers.delete(send); // a broken stream is dropped
          try {
            close();
          } catch {}
        }
      }
    }
  };

  return {
    subscribe(send, close) {
      if (closed) {
        close();
        return () => {};
      }
      try {
        send({ type: "snapshot", state: { ...state } });
      } catch {
        return () => {};
      }
      subscribers.set(send, close);
      return () => void subscribers.delete(send);
    },
    snapshot: () => ({ ...state }),
    events(events, sources) {
      const before: Transcript = state;
      const after = applyEvents(before, events, sources);
      state = { ...state, lines: after.lines, streaming: after.streaming, busy: after.busy, connected: true };
      broadcast(transcriptUpdates(before, after, events.some((e) => e.type === "snapshot")));
    },
    jobs(jobs) {
      const views = jobs.map(jobView);
      if (JSON.stringify(views) === JSON.stringify(state.jobs)) return;
      state = { ...state, jobs: views };
      broadcast([{ type: "jobs", jobs: views }]);
    },
    secrets(pending) {
      const views = pending.map(secretView);
      if (JSON.stringify(views) === JSON.stringify(state.secrets)) return;
      state = { ...state, secrets: views };
      broadcast([{ type: "secrets", pending: views }]);
    },
    close() {
      closed = true;
      const closes = [...subscribers.values()];
      subscribers.clear();
      for (const close of closes) {
        try {
          close();
        } catch {}
      }
    },
  };
}

/** A hub fed by `ctx` for as long as it runs; `stop` closes it and ends the watches. */
export async function startLive(
  ctx: Pick<SurfaceContext, "root" | "jobs" | "secrets">,
): Promise<Hub & { stop(): Promise<void> }> {
  const hub = createHub();
  const watches: { stop(): Promise<void> }[] = [];
  const stop = async () => {
    hub.close();
    await Promise.all(watches.splice(0).map((w) => w.stop()));
  };
  try {
    watches.push(await ctx.root.events((events, sources) => hub.events(events, sources)));
    watches.push(await ctx.jobs((jobs) => hub.jobs(jobs)));
    watches.push(await ctx.secrets.pending((pending) => hub.secrets(pending)));
  } catch (error) {
    await stop();
    throw error;
  }
  return { ...hub, stop };
}
