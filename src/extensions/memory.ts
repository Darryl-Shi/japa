import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Memory, MemoryProvider } from "../core/contracts.ts";
import type { Extension, Host } from "../core/host.ts";

export const MAX_MEMORY_CHARS = 6_000;

/** Legacy data is retained, but never consulted after the one-time migration. */
export const MemoryDoc = defineDoc<{
  records: {
    key: string;
    text: string;
    source: "user" | "inferred";
    updatedAt: number;
  }[];
  historyCutoff: number;
  migratedToFile?: boolean;
}>({
  kind: "japa.memory",
  version: 1,
  scope: "session",
  initial: () => ({ records: [], historyCutoff: 0 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
});

// Share the queue across provider instances for the same absolute filename.
// The CLI's home lock excludes other Japa processes; editors do not take this lock.
const writes = new Map<string, Promise<void>>();

function serial<T>(
  filename: string,
  context: Context,
  work: () => Promise<T>,
): Promise<T> {
  const result = (writes.get(filename) ?? Promise.resolve()).then(() => {
    context.abortSignal?.throwIfAborted();
    return work();
  });
  const settled = result.then(
    () => {},
    () => {},
  );
  writes.set(filename, settled);
  void settled.then(() => {
    if (writes.get(filename) === settled) writes.delete(filename);
  });
  return result;
}

function memory(text: string): Memory {
  return { text, revision: createHash("sha256").update(text).digest("hex") };
}

function validate(text: string, filename: string): void {
  if (typeof text !== "string" || text.length > MAX_MEMORY_CHARS) {
    throw new Error(
      `Memory at ${filename} must be text of at most ${MAX_MEMORY_CHARS} characters; compact the note explicitly (nothing was truncated).`,
    );
  }
}

async function fileText(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function checkRevision(text: string | undefined, revision: string): void {
  if (memory(text ?? "").revision !== revision) {
    throw new Error(
      "Memory revision conflict: read the current note and reconcile your rewrite before retrying.",
    );
  }
}

/** Without a revision, install only if absent (even an empty existing file wins). */
async function atomicWrite(
  filename: string,
  text: string,
  revision?: string,
): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(filename),
    `.${basename(filename)}.${randomUUID()}.tmp`,
  );
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    if (revision === undefined) {
      // Hard-link installation is atomic and cannot overwrite a user's file
      // created during startup. Rewrites below use atomic replacement instead.
      try {
        await link(temporary, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else {
      // Recheck after preparing the file to catch edits made during that work.
      // An uncooperative editor can still race the final check and rename.
      checkRevision(await fileText(filename), revision);
      await rename(temporary, filename);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function initialize(filename: string, host: Host): Promise<void> {
  const context = BACKGROUND_CONTEXT;
  await serial(filename, context, async () => {
    const legacy = await host.harness.snapshot(MemoryDoc, context);
    let text = await fileText(filename);
    if (text === undefined) {
      text = "";
      if (!legacy?.migratedToFile && legacy?.records.length) {
        text =
          "# Memory\n\nMigrated saved facts; review and rewrite this note as needed.\n\n" +
          legacy.records
            .map(
              (record) =>
                `## ${record.key}\n\n${record.text}\n\n_Source: ${record.source}; updatedAt: ${record.updatedAt}_\n`,
            )
            .join("\n");
        if (text.length > MAX_MEMORY_CHARS) {
          throw new Error(
            `Legacy memory needs ${text.length} characters, exceeding the ${MAX_MEMORY_CHARS}-character limit. All original records remain in the session database's japa.memory document. Create ${filename} with a reviewed note of at most ${MAX_MEMORY_CHARS} characters (or an empty file to skip import), then restart. No records were deleted or truncated.`,
          );
        }
      }
      await atomicWrite(filename, text);
      // A file created by an editor during installation takes precedence.
      text = (await fileText(filename)) ?? "";
    }
    validate(text, filename);
    await chmod(filename, 0o600);
    if (!legacy?.migratedToFile) {
      // Commit only after the file exists. A crash before this commit is safe:
      // the existing file wins on retry. Retain all old records and transcripts.
      await host.harness.commit(async (tx) => {
        (await tx.doc(MemoryDoc)).migratedToFile = true;
      }, context);
    }
  });
}

/** A compact human-editable note; rewriting it does not erase raw history. */
export function memoryExtension(filename: string): Extension {
  filename = resolve(filename);
  const provider: MemoryProvider = {
    async read(context) {
      context.abortSignal?.throwIfAborted();
      const text = (await fileText(filename)) ?? "";
      validate(text, filename);
      return memory(text);
    },
    rewrite(text, revision, context) {
      return serial(filename, context, async () => {
        validate(text, filename);
        checkRevision(await fileText(filename), revision);
        await atomicWrite(filename, text, revision);
        return memory(text);
      });
    },
  };
  return {
    name: "japa.memory",
    adapters: { memory: () => provider },
    start: (host) => initialize(filename, host),
  };
}
