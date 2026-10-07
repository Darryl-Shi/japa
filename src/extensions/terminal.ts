import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import type { Channel } from "../core/contracts.ts";
import type { Extension } from "../core/host.ts";
import type { SettingsUI } from "../core/settings.ts";

const plain = (text: string) =>
  text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

/** Separate from the chat reader: credentials never become Incoming messages. */
export function terminalSettings(input = stdin, output = stdout): SettingsUI {
  return {
    async notify(message, context) {
      context.abortSignal?.throwIfAborted();
      output.write(`${plain(message)}\n`);
    },
    async prompt(request, context) {
      context.abortSignal?.throwIfAborted();
      if (!input.isTTY)
        throw new Error(
          "Setup needs an interactive terminal. Run japa in a terminal or supply OPENAI_API_KEY / ANTHROPIC_API_KEY.",
        );
      while (true) {
        // Enter raw mode before displaying a prompt: a fast paste must not reach
        // the terminal driver's normal echo while readline is being created.
        // readline performs editing but its echo is discarded for secret input.
        const echo = new Writable({
          write(chunk, _encoding, done) {
            if (!(request.kind === "text" && request.secret))
              output.write(chunk);
            done();
          },
        });
        const reader = createInterface({
          input,
          output: echo,
          terminal: true,
          historySize: 0,
        });
        const pending = new Promise<string | undefined>((resolve) => {
          let settled = false;
          const finish = (value?: string) => {
            if (settled) return;
            settled = true;
            context.abortSignal?.removeEventListener("abort", abort);
            reader.close();
            resolve(value);
          };
          const abort = () => finish();
          reader.once("line", (line) => finish(line));
          reader.once("close", () => finish());
          reader.once("SIGINT", () => finish());
          context.abortSignal?.addEventListener("abort", abort, { once: true });
          if (context.abortSignal?.aborted) finish();
        });
        if (!context.abortSignal?.aborted) {
          output.write(`\n${plain(request.title)}\n`);
          if (request.kind === "choice")
            request.choices.forEach((choice, index) =>
              output.write(
                `  ${index + 1}. ${plain(choice.label)}${choice.value === request.defaultValue ? " (default)" : ""}\n`,
              ),
            );
          output.write(
            request.kind === "text" && request.secret ? "> (hidden) " : "> ",
          );
        }
        const answer = await pending;
        echo.end();
        output.write("\n");
        if (answer === undefined) return undefined;
        if (request.kind === "text")
          return answer || request.defaultValue || "";
        const selected = answer.trim() || request.defaultValue;
        const choice =
          request.choices.find((item) => item.value === selected) ??
          (/^\d+$/.test(selected ?? "")
            ? request.choices[Number(selected) - 1]
            : undefined);
        if (choice) return choice.value;
        output.write("Choose one of the listed options. Ctrl+C cancels.\n");
      }
    },
  };
}

export function terminalChannel() {
  let active = false;
  const settings = terminalSettings();
  let finish!: (reason: "exit" | "eof" | "settings") => void;
  const closed = new Promise<"exit" | "eof" | "settings">((resolve) => {
    finish = resolve;
  });
  const channel: Channel = {
    settings: {
      notify: settings.notify,
      async prompt(request, context) {
        if (active)
          throw new Error(
            "Stop the chat reader before opening terminal settings",
          );
        return settings.prompt(request, context);
      },
    },
    async start(receive) {
      active = true;
      const reader = createInterface({
        input: stdin,
        output: stdout,
        terminal: stdin.isTTY,
      });
      const pending = new Set<Promise<void>>();
      let reason: "exit" | "eof" | "settings" = "eof";
      reader.on("line", (line) => {
        if (line.trim() === "/exit" || line.trim() === "/settings") {
          reason = line.trim() === "/settings" ? "settings" : "exit";
          reader.close();
          return;
        }
        const admission = receive({
          id: randomUUID(),
          address: { channel: "terminal", recipient: "owner" },
          text: line,
        }).catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : error);
        });
        pending.add(admission);
        void admission.finally(() => pending.delete(admission));
      });
      reader.on("close", () => {
        void Promise.all(pending).then(() => {
          active = false;
          finish(reason);
        });
      });
      return async () => {
        reader.close();
        await Promise.all(pending);
        active = false;
      };
    },
    async send(address, message) {
      if (address.channel !== "terminal" || address.recipient !== "owner")
        throw new Error("Unknown terminal address");
      stdout.write(`\n${plain(message.text)}\n\n`);
    },
  };
  const extension: Extension = {
    name: "japa.terminal",
    adapters: { channel: () => channel },
  };
  return { channel, extension, closed };
}
