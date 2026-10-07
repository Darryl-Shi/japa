import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentTools, Type } from "@earendil-works/pi-ai";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { AssistantState } from "../src/extensions/state.ts";
import { textOf } from "../src/extensions/text.ts";
import { abortable, context, fixture, until } from "./helpers.ts";

const answer = (text: string) => fauxAssistantMessage(text);
const call = (name: string, args: ToolCall["arguments"]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const last = (messages: readonly Message[]) =>
  messages.findLast((message) => message.role !== "system")!;

test("root delegates, stays available, and reviews a background result", async (t) => {
  let release!: () => void;
  const workerGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let workerStarted = false;
  const rootRequests: Message[][] = [];
  const tools: Record<string, string[]> = {};
  const app = await fixture(t, async (request, options, _state, model) => {
    tools[model.id] = getCurrentTools(request.messages).map(
      (tool) => tool.name,
    );
    const message = last(request.messages);
    if (model.id === "worker") {
      workerStarted = true;
      assert(
        !request.messages.some((message) =>
          textOf(message).includes("private small talk"),
        ),
      );
      await abortable(workerGate, options?.signal);
      return answer(
        "Compared three hotels. Hotel A meets the budget; see hotels.md.",
      );
    }
    rootRequests.push([...request.messages]);
    if (textOf(message) === "Plan my trip")
      return call("commitment", {
        outcome: "Plan the trip",
        status: "open",
        nextAction: "Compare hotels",
      });
    if (message.role === "toolResult" && message.toolName === "commitment") {
      return call("job_start", {
        title: "Compare hotels",
        instructions: "Compare three hotels under $200 and report evidence.",
      });
    }
    if (message.role === "toolResult")
      return answer("I'm comparing hotels. We can keep talking meanwhile.");
    if (textOf(message).startsWith("Background job update"))
      return answer("Hotel A fits your budget. Here are the findings.");
    return answer("I'm here.");
  });
  await app.say("private small talk");
  await until(() => app.sent.length === 1);
  await app.say("Plan my trip");
  await until(() => workerStarted && app.sent.length === 2);
  await app.say("Are you still there?");
  await until(() => app.sent.length === 3);
  assert.equal(
    (await app.host.adapters.jobs.list(context))[0]?.status,
    "running",
  );
  assert(!tools.root!.includes("bash"));
  assert(!tools.root!.includes("extension_install"));
  assert(tools.worker!.includes("bash"));
  assert(tools.worker!.includes("extension_install"));
  assert(!tools.worker!.includes("job_start"));
  release();
  await until(() => app.sent.length === 4);
  assert.match(app.sent[3]!.text, /Hotel A/);
  assert.equal(
    (await app.host.adapters.jobs.list(context))[0]?.status,
    "completed",
  );
  // Completing a worker does not automatically discharge the promise.
  assert.equal(
    (await app.host.harness.snapshot(AssistantState, context))?.commitments[0]
      ?.status,
    "open",
  );
  assert(
    rootRequests.every((messages) => JSON.stringify(messages).length <= 32_000),
  );
  assert.deepEqual(app.errors, []);
});

test("a worker uses the real computer while the root cannot", async (t) => {
  const app = await fixture(t, (request, _options, _state, model) => {
    const message = last(request.messages);
    if (model.id === "worker") {
      if (message.role === "toolResult")
        return answer(
          "Created result.txt and verified the write tool succeeded.",
        );
      return call("write", { path: "result.txt", content: "worker output" });
    }
    if (textOf(message) === "Create a file")
      return call("job_start", {
        title: "Create file",
        instructions: "Write worker output to result.txt",
      });
    return answer("Done or delegated.");
  });
  await app.say("Create a file");
  await until(
    async () =>
      (await app.host.adapters.jobs.list(context))[0]?.status === "completed",
  );
  assert.equal(
    await readFile(join(app.home, "workspace", "result.txt"), "utf8"),
    "worker output",
  );
  const root = await app.host.harness.root(context);
  const agent = await root.agent(context);
  assert.deepEqual(
    agent.tools.map((tool) => tool.name),
    [
      "job_start",
      "jobs",
      "commitment",
      "commitments",
      "focus",
      "memory",
      "wake",
      "notify",
    ],
  );
});

test("SQLite restart resumes a safe worker tool and reports exactly once", async (t) => {
  let calls = 0;
  let resume = false;
  const app = await fixture(
    t,
    (request, _options, _state, model) => {
      const message = last(request.messages);
      if (model.id === "worker")
        return message.role === "toolResult"
          ? answer("Recovered result")
          : call("checkpoint", {});
      if (textOf(message) === "Delegate")
        return call("job_start", {
          title: "Recovery",
          instructions: "Use checkpoint then report.",
        });
      return answer(
        textOf(message).startsWith("Background job update")
          ? "Worker recovered."
          : "Working on it.",
      );
    },
    {
      sqlite: true,
      extras: [
        {
          name: "test-worker",
          register: () => ({
            name: "test-worker",
            tools: [
              defineTool({
                name: "checkpoint",
                description: "A safe test effect",
                parameters: Type.Object({}),
                replay: "safe",
                async execute(_args, _api, context) {
                  calls++;
                  if (!resume)
                    await abortable(
                      new Promise<never>(() => {}),
                      context.abortSignal,
                    );
                  return {
                    content: [{ type: "text", text: "effect complete" }],
                  };
                },
              }),
            ],
          }),
        },
      ],
    },
  );
  await app.say("Delegate", "stable-input");
  await until(() => calls === 1 && app.sent.length === 1);
  const before = (await app.host.adapters.jobs.list(context))[0]!;
  resume = true;
  await app.reopen();
  await app.say("Delegate", "stable-input");
  await until(() => app.sent.some((item) => item.text === "Worker recovered."));
  const after = await app.host.adapters.jobs.list(context);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.conversationId, before.conversationId);
  assert.equal(after[0]!.status, "completed");
  assert.equal(calls, 2);
  assert.equal(
    app.sent.filter((item) => item.text === "Worker recovered.").length,
    1,
  );
  assert.deepEqual(app.errors, []);
});

test("cancelling a job cancels its worker without blocking the root", async (t) => {
  let working = false;
  const app = await fixture(t, async (request, options, _state, model) => {
    if (model.id === "worker") {
      working = true;
      return abortable(new Promise<never>(() => {}), options?.signal);
    }
    return last(request.messages).role === "toolResult"
      ? answer("Delegated")
      : call("job_start", {
          title: "Long work",
          instructions: "Work until cancelled",
        });
  });
  await app.say("Start");
  await until(() => working && app.sent.length === 1);
  const job = (await app.host.adapters.jobs.list(context))[0]!;
  await app.host.adapters.jobs.cancel(job.id, context);
  assert.equal(
    (await app.host.adapters.jobs.list(context))[0]!.status,
    "cancelled",
  );
  assert.equal(
    (await app.host.harness.getTask(job.taskId, context))!.state.status,
    "terminal",
  );
});

test("a steer at the final boundary is included in the job's reported outcome", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let working = false;
  const app = await fixture(t, async (request, options, _state, model) => {
    const message = last(request.messages);
    if (model.id === "worker") {
      if (textOf(message) === "Use the revised requirement")
        return answer("Revised outcome");
      working = true;
      await abortable(gate, options?.signal);
      return answer("Original outcome");
    }
    if (textOf(message) === "Start")
      return call("job_start", {
        title: "Steering",
        instructions: "Original requirement",
      });
    return answer("Acknowledged");
  });
  await app.say("Start");
  await until(() => working && app.sent.length === 1);
  const job = (await app.host.adapters.jobs.list(context))[0]!;
  await app.host.adapters.jobs.steer(
    job.id,
    "Use the revised requirement",
    "revision-1",
    context,
  );
  release();
  await until(
    async () =>
      (await app.host.adapters.jobs.list(context))[0]?.status === "completed",
  );
  assert.equal(
    (await app.host.adapters.jobs.list(context))[0]!.result,
    "Revised outcome",
  );
  await assert.rejects(
    app.host.adapters.jobs.steer(job.id, "Too late", "revision-2", context),
    /completed/,
  );
});

test("queued messages cannot reroute a job to the wrong recipient", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let preparing = false;
  const app = await fixture(t, async (request, options, _state, model) => {
    if (model.id === "worker") return answer("Result for Alice");
    if (textOf(last(request.messages)) === "Alice's task") {
      preparing = true;
      await abortable(gate, options?.signal);
      return call("job_start", {
        title: "Alice",
        instructions: "Work for Alice",
      });
    }
    return answer("Acknowledged");
  });
  await app.say("Alice's task", "alice-task", "alice");
  await until(() => preparing);
  await app.say("Bob's question", "bob-question", "bob");
  release();
  await until(
    async () =>
      (await app.host.adapters.jobs.list(context))[0]?.status === "completed",
  );
  assert.equal(
    (await app.host.adapters.jobs.list(context))[0]!.address.recipient,
    "alice",
  );
});

test(
  "a worker builds an extension and uses it in the same job",
  { timeout: 30_000 },
  async (t) => {
    const source = `
    import { Type } from "@earendil-works/pi-ai";
    import { defineTool } from "@earendil-works/pi-durable";
    export default { name: "hello", register() { return { name: "hello", tools: [defineTool({
      name: "hello", description: "A new ability", parameters: Type.Object({}), replay: "safe",
      async execute() { return { content: [{ type: "text", text: "Hello from my new capability" }] }; }
    })] }; } };
  `;
    const app = await fixture(t, (request, _options, _state, model) => {
      const message = last(request.messages);
      if (model.id === "worker") {
        if (message.role !== "toolResult")
          return call("extension_install", { name: "hello", source });
        if (message.toolName === "extension_install") {
          assert.equal(message.isError, false, textOf(message));
          assert(
            getCurrentTools(request.messages).some(
              (tool) => tool.name === "hello",
            ),
          );
          return call("hello", {});
        }
        return answer(textOf(message));
      }
      if (textOf(message) === "Build an ability")
        return call("job_start", {
          title: "Build hello",
          instructions: "Build and use hello",
        });
      return answer("Understood");
    });
    await app.say("Build an ability");
    await until(
      async () =>
        (await app.host.adapters.jobs.list(context))[0]?.status === "completed",
      25_000,
    );
    assert.match(
      (await app.host.adapters.jobs.list(context))[0]!.result,
      /Hello from my new capability/,
    );
    const root = await app.host.harness.root(context);
    assert(
      !(await root.agent(context)).tools.some((tool) => tool.name === "hello"),
    );
  },
);

test("reflective memory personalizes turns; an explicit forget clears the note and stale focus", async (t) => {
  const requests: string[] = [];
  let revision = "";
  const app = await fixture(t, (request) => {
    requests.push(JSON.stringify(request.messages));
    if (textOf(last(request.messages)) === "Forget my style")
      return call("memory", {
        action: "rewrite",
        text: "",
        revision,
        forget: true,
      });
    return answer("Hello");
  });
  const old = await app.host.adapters.memory.read(context);
  revision = (
    await app.host.adapters.memory.rewrite(
      "Prefer extremely concise replies",
      old.revision,
      context,
    )
  ).revision;
  await app.say("Hello");
  await until(() => app.sent.length === 1);
  assert.match(requests[0]!, /Prefer extremely concise replies/);
  await app.host.harness.commit(async (tx) => {
    const state = await tx.doc(AssistantState);
    state.focus = "Prefer extremely concise replies";
    state.focusUpdatedAt = Date.now();
  }, context);
  await app.say("Forget my style");
  await until(() => app.sent.length === 2);
  await app.say("New topic");
  await until(() => app.sent.length === 3);
  assert(!requests.at(-1)!.includes("Prefer extremely concise replies"));
  assert.equal(await readFile(join(app.home, "MEMORY.md"), "utf8"), "");
  assert.equal(
    (await app.host.harness.snapshot(AssistantState, context))?.focus,
    "",
  );
});

test("a full memory note stays intact when oversized operational state is omitted", async (t) => {
  let projected = "";
  const app = await fixture(t, (request) => {
    projected = JSON.stringify(request.messages);
    assert(
      getCurrentTools(request.messages).some(
        (tool) => tool.name === "job_start",
      ),
    );
    return answer("Ready");
  });
  const memory = await app.host.adapters.memory.read(context);
  const note = "A lasting preference.\n".repeat(260);
  await app.host.adapters.memory.rewrite(note, memory.revision, context);
  await app.host.harness.commit(async (tx) => {
    const state = await tx.doc(AssistantState);
    for (let i = 0; i < 20; i++)
      state.commitments.push({
        id: `promise-${i}`,
        outcome: "\u0000".repeat(400),
        nextAction: "\u0000".repeat(300),
        due: "later",
        status: "open",
      });
  }, context);
  await app.say("What is next?");
  await until(() => app.sent.length === 1);
  assert(projected.length <= 32_000);
  const messages = JSON.parse(projected) as Message[];
  const brief = JSON.parse(
    textOf(
      messages.find((message) =>
        textOf(message).startsWith("Executive brief"),
      )!,
    )
      .split("\n")
      .slice(1)
      .join("\n"),
  );
  assert.equal(brief.memory.text, note);
  assert(brief.omittedCommitments > 12);
  assert.deepEqual(app.errors, []);
});

test("job time budgets survive as durable deadlines", async (t) => {
  const app = await fixture(
    t,
    async (request, options, _state, model) => {
      if (model.id === "worker")
        return abortable(new Promise<never>(() => {}), options?.signal);
      if (textOf(last(request.messages)) === "Start")
        return call("job_start", { title: "Timeout", instructions: "Work" });
      return answer("Acknowledged");
    },
    { jobTimeoutMs: 60 },
  );
  await app.say("Start");
  await until(
    async () =>
      (await app.host.adapters.jobs.list(context))[0]?.status === "failed",
  );
  const job = (await app.host.adapters.jobs.list(context))[0]!;
  assert.match(job.result, /timeout|time|aborted/i);
});
