import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { withAbortSignal } from "@earendil-works/chord/context";
import { terminalSettings } from "../src/extensions/terminal.ts";
import { context } from "./helpers.ts";

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  return {
    input,
    output,
    ui: terminalSettings(
      input as unknown as typeof process.stdin,
      output as unknown as typeof process.stdout,
    ),
    text: () => text,
  };
}

test("terminal secret input is hidden and never enters readline history", async () => {
  const { input, ui, text } = terminal();
  const answer = ui.prompt(
    { kind: "text", title: "API key", secret: true },
    context,
  );
  input.write("sk-this-must-stay-private\n");
  assert.equal(await answer, "sk-this-must-stay-private");
  assert(!text().includes("sk-this-must-stay-private"));
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("keypress"), 0);
});

test("secret prompt is shown only after terminal echo is disabled", async () => {
  const { input, output, ui, text } = terminal();
  let ready = false;
  output.on("data", (chunk) => {
    if (!chunk.toString().includes("(hidden)")) return;
    ready = true;
    assert.equal(
      input.isRaw,
      true,
      "fast input must not reach the terminal driver's echo",
    );
    input.write("instant-paste-secret\n");
  });
  assert.equal(
    await ui.prompt({ kind: "text", title: "Key", secret: true }, context),
    "instant-paste-secret",
  );
  assert(ready);
  assert(!text().includes("instant-paste-secret"));
});

test("terminal choices use stable IDs and cancellation releases the input", async () => {
  const { input, ui } = terminal();
  const answer = ui.prompt(
    {
      kind: "choice",
      title: "Provider",
      choices: [
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
      ],
    },
    context,
  );
  input.write("2\n");
  assert.equal(await answer, "anthropic");
  const controller = new AbortController();
  const cancelled = ui.prompt(
    { kind: "text", title: "OAuth callback", secret: true },
    withAbortSignal(controller.signal, context),
  );
  controller.abort();
  assert.equal(await cancelled, undefined);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("keypress"), 0);
});

test("noninteractive input cannot accidentally consume chat text as a credential", async () => {
  const { input, ui } = terminal();
  input.isTTY = false;
  await assert.rejects(
    ui.prompt({ kind: "text", title: "API key", secret: true }, context),
    /interactive terminal/,
  );
});
