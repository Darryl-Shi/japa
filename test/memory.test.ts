import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Host } from "../src/core/host.ts";
import {
  MAX_MEMORY_CHARS,
  MemoryDoc,
  memoryExtension,
} from "../src/extensions/memory.ts";

const context = BACKGROUND_CONTEXT;
const revision = (text: string) =>
  createHash("sha256").update(text).digest("hex");

async function open(filename: string, storage: Storage = new MemoryStorage()) {
  // No default extensions, credentials, scheduler or network needed.
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context,
  );
  const host = { harness } as Host;
  const extension = memoryExtension(filename);
  const memory = extension.adapters!.memory!(host);
  return {
    harness,
    host,
    memory,
    extension,
    start: () => extension.start!(host),
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "japa-memory-"));
  const filename = join(directory, "MEMORY.md");
  const result = await open(filename);
  t.after(async () => {
    await result.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  });
  return { ...result, filename, directory };
}

const legacyRecords = [
  {
    key: "drink",
    text: "Prefers green tea, not coffee.",
    source: "user" as const,
    updatedAt: 101,
  },
  {
    key: "work-style",
    text: "Likely prefers quiet mornings.\nAsk before scheduling calls.",
    source: "inferred" as const,
    updatedAt: 102,
  },
];

async function seed(harness: Harness, records = legacyRecords) {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(MemoryDoc);
    doc.records = records;
    doc.historyCutoff = 99;
  }, context);
}

async function assertLegacyRetained(harness: Harness) {
  const doc = await harness.snapshot(MemoryDoc, context);
  assert.deepEqual(doc!.records, legacyRecords);
  assert.equal(doc!.historyCutoff, 99);
  assert.equal(doc!.migratedToFile, true);
}

test("missing memory reads empty; startup creates a private note without a root", async (t) => {
  const { memory, extension, harness, filename, start } = await fixture(t);
  assert.equal(extension.name, "japa.memory");
  assert.deepEqual(Object.keys(extension.adapters!), ["memory"]);
  assert.equal(extension.register, undefined);
  assert.equal(typeof extension.start, "function");
  assert.deepEqual(await memory.read(context), {
    text: "",
    revision: revision(""),
  });
  await assert.rejects(stat(filename), { code: "ENOENT" });
  assert.equal(await harness.snapshot(MemoryDoc, context), undefined);
  await start();
  assert.equal(await readFile(filename, "utf8"), "");
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal(
    (await harness.snapshot(MemoryDoc, context))!.migratedToFile,
    true,
  );
  assert.equal(
    await harness.conversation(ROOT_CONVERSATION_ID, context),
    undefined,
  );
});

test("rewrites replace the complete file, preserve exact text and allow empty memory", async (t) => {
  const { memory, filename, directory, harness, start } = await fixture(t);
  await start();
  const bookkeeping = await harness.snapshot(MemoryDoc, context);
  let current = await memory.read(context);
  for (const text of [
    "# Memory\n\nPrefers tea.\nOld fact to remove.\n",
    "  # Reflection\r\n\r\n日本語 and café.\t\n",
    "",
    "  \n\t",
  ]) {
    current = await memory.rewrite(text, current.revision, context);
    assert.deepEqual(current, { text, revision: revision(text) });
    assert.equal(await readFile(filename, "utf8"), text);
    assert.deepEqual(await memory.read(context), current);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["MEMORY.md"]);
  }
  assert.deepEqual(
    await harness.snapshot(MemoryDoc, context),
    bookkeeping,
    "normal reads and rewrites do not store a second copy in native documents",
  );
  current.text = "caller mutation";
  assert.equal((await memory.read(context)).text, "  \n\t");
});

test("rewriting a missing note creates private parent directories and file", async (t) => {
  const { directory, host } = await fixture(t);
  const filename = join(directory, "private", "nested", "MEMORY.md");
  const memory = memoryExtension(filename).adapters!.memory!(host);
  const empty = await memory.read(context);
  await memory.rewrite("New note", empty.revision, context);
  assert.equal(await readFile(filename, "utf8"), "New note");
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(directory, "private", "nested"))).mode & 0o777,
    0o700,
  );
});

test("stale writes conflict without changing the file or poisoning later writes", async (t) => {
  const { memory, filename, directory } = await fixture(t);
  const before = await memory.read(context);
  const after = await memory.rewrite(
    "First reflection",
    before.revision,
    context,
  );
  await assert.rejects(
    memory.rewrite("Stale reflection", before.revision, context),
    /revision conflict.*read the current note/i,
  );
  assert.equal(await readFile(filename, "utf8"), after.text);
  assert.deepEqual(await readdir(directory), ["MEMORY.md"]);
  const next = await memory.rewrite(
    "Reconciled reflection",
    after.revision,
    context,
  );
  assert.equal(next.text, "Reconciled reflection");
});

test("concurrent compare-and-swap writes, including separate providers, have one winner", async (t) => {
  const { memory, host, filename, directory } = await fixture(t);
  const second = memoryExtension(filename).adapters!.memory!(host);
  const before = await memory.read(context);
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, (_, i) =>
      (i % 2 ? memory : second).rewrite(
        `Reflection ${i}`,
        before.revision,
        context,
      ),
    ),
  );
  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  for (const result of results) {
    if (result.status === "rejected") {
      assert.match(String(result.reason), /revision conflict/i);
    }
  }
  const winner = winners[0]!;
  assert.equal(winner.status, "fulfilled");
  assert.deepEqual(await memory.read(context), winner.value);
  assert.deepEqual(await second.read(context), winner.value);
  assert.equal(await readFile(filename, "utf8"), winner.value.text);
  assert.deepEqual(await readdir(directory), ["MEMORY.md"]);
});

test("readers observe only complete old or new files during atomic rewrites", async (t) => {
  const { memory, filename, directory } = await fixture(t);
  const notes = ["a".repeat(MAX_MEMORY_CHARS), "b".repeat(MAX_MEMORY_CHARS)];
  let current = await memory.read(context);
  current = await memory.rewrite(notes[0]!, current.revision, context);
  const writer = async () => {
    for (let i = 0; i < 30; i++) {
      current = await memory.rewrite(
        notes[i % notes.length]!,
        current.revision,
        context,
      );
    }
  };
  const reader = async () => {
    for (let i = 0; i < 150; i++) {
      assert.ok(notes.includes(await readFile(filename, "utf8")));
      const observed = await memory.read(context);
      assert.ok(notes.includes(observed.text));
      assert.equal(observed.revision, revision(observed.text));
    }
  };
  await Promise.all([writer(), reader(), reader()]);
  assert.equal(await readFile(filename, "utf8"), current.text);
  assert.deepEqual(await readdir(directory), ["MEMORY.md"]);
});

test("direct edits are immediately visible and invalidate prior revisions", async (t) => {
  const { memory, filename } = await fixture(t);
  const before = await memory.read(context);
  await writeFile(filename, "  Human-edited note\r\n");
  const edited = await memory.read(context);
  assert.deepEqual(edited, {
    text: "  Human-edited note\r\n",
    revision: revision("  Human-edited note\r\n"),
  });
  await assert.rejects(
    memory.rewrite("Overwrite", before.revision, context),
    /conflict/,
  );
  await memory.rewrite("Reconciled with user edit", edited.revision, context);
  const saved = await memory.read(context);
  await rm(filename);
  assert.deepEqual(await memory.read(context), {
    text: "",
    revision: revision(""),
  });
  await assert.rejects(
    memory.rewrite("Resurrect", saved.revision, context),
    /conflict/,
  );
});

test("the 6000-character limit rejects oversized rewrites without trimming or data loss", async (t) => {
  assert.equal(MAX_MEMORY_CHARS, 6_000);
  const { memory, filename, directory } = await fixture(t);
  const text = "界".repeat(MAX_MEMORY_CHARS);
  const empty = await memory.read(context);
  const full = await memory.rewrite(text, empty.revision, context);
  assert.equal((await memory.read(context)).text.length, MAX_MEMORY_CHARS);
  for (const oversized of [text + "x", " ".repeat(MAX_MEMORY_CHARS + 1)]) {
    await assert.rejects(
      memory.rewrite(oversized, full.revision, context),
      /at most 6000 characters.*nothing was truncated/,
    );
    assert.deepEqual(await memory.read(context), full);
  }
  await assert.rejects(
    memory.rewrite(null as unknown as string, full.revision, context),
    /must be text/,
  );
  assert.equal(await readFile(filename, "utf8"), text);
  assert.deepEqual(await readdir(directory), ["MEMORY.md"]);
});

test("oversized direct edits fail visibly, remain intact and can be compacted explicitly", async (t) => {
  const { memory, filename, start } = await fixture(t);
  const oversized = "Important user text.\n".repeat(400);
  await writeFile(filename, oversized);
  await assert.rejects(memory.read(context), /compact the note explicitly/);
  await assert.rejects(start(), /compact the note explicitly/);
  assert.equal(await readFile(filename, "utf8"), oversized);
  // The digest of the actual file still permits an explicitly reconciled rewrite.
  await memory.rewrite("Reviewed compact note", revision(oversized), context);
  assert.equal((await memory.read(context)).text, "Reviewed compact note");
});

test("file contents and revisions survive provider recreation with unrelated storage", async (t) => {
  const { memory, filename } = await fixture(t);
  const before = await memory.read(context);
  const saved = await memory.rewrite(
    "# Memory\n\nPersistent reflection.\n",
    before.revision,
    context,
  );
  const reopened = await open(filename);
  try {
    assert.deepEqual(await reopened.memory.read(context), saved);
    await reopened.start();
    assert.deepEqual(await reopened.memory.read(context), saved);
    const rewritten = await reopened.memory.rewrite(
      "A new reflection",
      saved.revision,
      context,
    );
    assert.deepEqual(await memory.read(context), rewritten);
  } finally {
    await reopened.harness.close(context);
  }
});

test("SQLite legacy migration preserves raw facts and transcripts and never resurrects deleted memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "japa-memory-sqlite-"));
  const filename = join(directory, "MEMORY.md");
  const database = join(directory, "session.sqlite");
  let current: Awaited<ReturnType<typeof open>> | undefined;
  try {
    current = await open(filename, await openNodeSqliteStorage(database));
    await seed(current.harness);
    await current.harness.root(context);
    const entry = await current.harness.commit(
      (tx) =>
        tx.appendEntry(ROOT_CONVERSATION_ID, {
          kind: "pi.user",
          model: [
            { role: "user", content: "Raw coffee conversation", timestamp: 1 },
          ],
        }),
      context,
    );
    assert.equal(
      (await current.memory.read(context)).text,
      "",
      "read does not import implicitly",
    );
    await current.start();
    const migrated = await current.memory.read(context);
    assert.match(migrated.text, /^# Memory\n/);
    for (const record of legacyRecords) {
      assert.ok(migrated.text.includes(record.key));
      assert.ok(migrated.text.includes(record.text));
      assert.ok(migrated.text.includes(record.source));
      assert.ok(migrated.text.includes(String(record.updatedAt)));
    }
    assert.equal(migrated.revision, revision(await readFile(filename, "utf8")));
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await assertLegacyRetained(current.harness);
    await current.memory.rewrite(
      "Only a reviewed reflection remains.",
      migrated.revision,
      context,
    );
    await current.harness.close(context);
    current = undefined;

    current = await open(filename, await openNodeSqliteStorage(database));
    await current.start();
    assert.equal(
      (await current.memory.read(context)).text,
      "Only a reviewed reflection remains.",
    );
    await assertLegacyRetained(current.harness);
    await current.harness.close(context);
    current = undefined;
    await rm(filename);

    current = await open(filename, await openNodeSqliteStorage(database));
    assert.equal((await current.memory.read(context)).text, "");
    await current.start();
    assert.equal(
      await readFile(filename, "utf8"),
      "",
      "completed migration must not revive old facts",
    );
    await assertLegacyRetained(current.harness);
    assert.deepEqual(
      await current.harness.commit((tx) => tx.entry(entry.id), context),
      entry,
      "rewriting or deleting memory does not erase raw transcript entries",
    );
  } finally {
    await current?.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing files always win over legacy facts, even when deliberately empty", async (t) => {
  for (const text of ["# My hand-written memory\n", ""]) {
    await t.test(text ? "nonempty" : "empty", async (t) => {
      const { harness, memory, filename, start } = await fixture(t);
      await seed(harness);
      await writeFile(filename, text, { mode: 0o644 });
      await start();
      assert.deepEqual(await memory.read(context), {
        text,
        revision: revision(text),
      });
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
      await assertLegacyRetained(harness);
      await rm(filename);
      await start();
      assert.equal((await memory.read(context)).text, "");
      await assertLegacyRetained(harness);
    });
  }
});

test("oversized legacy migration fails actionably without truncation, marking completion or data loss", async (t) => {
  const { harness, memory, filename, directory, start } = await fixture(t);
  const records = legacyRecords.map((record) => ({
    ...record,
    text: record.text + "x".repeat(4_000 - record.text.length),
  }));
  await seed(harness, records);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(start(), (error: Error) => {
      assert.match(error.message, /Legacy memory.*6000-character limit/);
      assert.match(error.message, /original records remain.*japa.memory/);
      assert.ok(error.message.includes(`Create ${filename}`));
      assert.match(error.message, /then restart/);
      return true;
    });
    assert.deepEqual(
      (await harness.snapshot(MemoryDoc, context))!.records,
      records,
    );
    assert.equal(
      (await harness.snapshot(MemoryDoc, context))!.migratedToFile,
      undefined,
    );
    assert.deepEqual(await readdir(directory), []);
  }
  // User reconciliation is explicit; the oversized originals remain available.
  await writeFile(filename, "Reviewed selected facts.\n");
  await start();
  assert.equal((await memory.read(context)).text, "Reviewed selected facts.\n");
  assert.equal(
    (await harness.snapshot(MemoryDoc, context))!.migratedToFile,
    true,
  );
  assert.deepEqual(
    (await harness.snapshot(MemoryDoc, context))!.records,
    records,
  );
  await rm(filename);
  await start();
  assert.equal((await memory.read(context)).text, "");
});

test("concurrent startup and a rewrite reconcile through the same queue", async (t) => {
  const { harness, memory, filename, start } = await fixture(t);
  await seed(harness);
  const empty = await memory.read(context);
  const [started, rewritten] = await Promise.allSettled([
    start(),
    memory.rewrite("Based on stale empty memory", empty.revision, context),
  ]);
  assert.equal(started.status, "fulfilled");
  assert.equal(rewritten.status, "rejected");
  if (rewritten.status === "rejected")
    assert.match(String(rewritten.reason), /conflict/);
  assert.ok(
    (await readFile(filename, "utf8")).includes(legacyRecords[0]!.text),
  );
  await assertLegacyRetained(harness);
});
