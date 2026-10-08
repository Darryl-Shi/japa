// The setup wizard's questions, asked through @clack/prompts (`clackPrompter`) or answered by a script in tests.
import * as clack from "@clack/prompts";
import { styleText } from "node:util";

/** One option offered by `Prompter.select`. */
export type Choice<T> = { label: string; value: T; hint?: string };

/** Thrown when the user quits setup (Ctrl-C, then confirming). */
export class Cancelled extends Error {}

export type TextOptions = {
  /** Prefilled, editable. */
  initial?: string;
  /** Dim text shown while the answer is empty; not part of the answer. */
  placeholder?: string;
  /** A short explanation shown next to the question. */
  help?: string;
  /** Aborting it withdraws the question: the prompt rejects with the signal's reason. */
  signal?: AbortSignal;
};

/** The setup wizard's I/O: questions (which may throw `Cancelled`) and output. Text answers come back trimmed. */
export type Prompter = {
  /** An informational line. */
  note(text: string): void;
  /** Something that went wrong, but setup carries on. */
  warn(text: string): void;
  /** A framed block, for something the user has to act on, such as a code to enter. */
  box(text: string, title?: string): void;
  /** A URL on a line of its own, never wrapped or framed, so it can be copied whole. */
  link(url: string): void;
  select<T>(question: string, choices: Choice<T>[], initial?: T): Promise<T>;
  multiselect<T>(question: string, choices: Choice<T>[], initial?: T[]): Promise<T[]>;
  text(question: string, opts?: TextOptions): Promise<string>;
  /** Masked input. "" means the user just pressed Enter. */
  secret(question: string, opts?: Omit<TextOptions, "initial">): Promise<string>;
  confirm(question: string, initial: boolean): Promise<boolean>;
  /** Shows `message` with a spinner until `work` settles; its result. */
  wait<T>(message: string, work: Promise<T>): Promise<T>;
};

/** Lists longer than this get a search box. */
const SEARCHABLE = 10;

const dim = (s: string) => styleText("dim", s);
const withHelp = (question: string, help?: string) => (help ? `${question} ${dim(`(${help})`)}` : question);

/**
 * A `Prompter` on the terminal, with a start (`intro`) and an end (`close`).
 *
 * Quitting takes Ctrl-C and a confirmation, never a single stray key: Esc does nothing, and Ctrl-C asks "Quit
 * setup?" (default No; a second Ctrl-C quits). So switching to a browser to fetch a key, or a terminal sending
 * an unexpected escape sequence, can't end the wizard.
 */
export function clackPrompter(): Prompter & { intro(title: string): void; close(message?: string): void } {
  clack.settings.aliases.delete("escape");

  /** Shows a prompt until it's answered; a cancelled one asks whether to quit, and is shown again if not. */
  async function ask<T>(show: () => Promise<T | symbol>, signal?: AbortSignal): Promise<T> {
    for (;;) {
      const answer = await show();
      if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
      if (!clack.isCancel(answer)) return answer as T;
      const quit = await clack.confirm({ message: "Quit setup? Steps you've finished are saved.", initialValue: false });
      if (clack.isCancel(quit) || quit) throw new Cancelled();
    }
  }

  return {
    intro: (title) => clack.intro(title),
    close: (message) => {
      if (message !== undefined) clack.outro(message);
    },
    note: (text) => clack.log.info(text),
    warn: (text) => clack.log.warn(text),
    box: (text, title) => clack.note(text, title),
    link: (url) => process.stdout.write(`\n${url}\n\n`),

    select: <T>(question: string, choices: Choice<T>[], initial?: T) => {
      const options = choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })) as clack.Option<T>[];
      if (choices.length <= SEARCHABLE) {
        return ask<T>(() => clack.select<T>({ message: question, options, initialValue: initial }));
      }
      return ask<T>(() =>
        clack.autocomplete<T>({
          message: `${question} ${dim("(type to search)")}`,
          options,
          initialValue: initial,
          maxItems: 10,
          filter: (search, o) => `${o.label ?? ""} ${o.hint ?? ""}`.toLowerCase().includes(search.toLowerCase()),
        }),
      );
    },

    multiselect: <T>(question: string, choices: Choice<T>[], initial?: T[]) => {
      const options = choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })) as clack.Option<T>[];
      return ask<T[]>(() =>
        clack.multiselect<T>({
          message: `${question} ${dim("(space selects, enter continues)")}`,
          options,
          initialValues: initial,
          required: false,
        }),
      );
    },

    text: async (question, opts = {}) =>
      String(
        (await ask<string | undefined>(
          () =>
            clack.text({
              message: withHelp(question, opts.help),
              placeholder: opts.placeholder,
              initialValue: opts.initial,
              signal: opts.signal,
            }),
          opts.signal,
        )) ?? "",
      ).trim(),

    secret: async (question, opts = {}) =>
      String(
        (await ask<string | undefined>(
          () =>
            clack.password({
              message: withHelp(question, opts.help),
              signal: opts.signal,
            }),
          opts.signal,
        )) ?? "",
      ).trim(),

    confirm: (question, initial) => ask<boolean>(() => clack.confirm({ message: question, initialValue: initial })),

    wait: async (message, work) => {
      const spinner = clack.spinner();
      spinner.start(message);
      try {
        const result = await work;
        spinner.stop(message);
        return result;
      } catch (error) {
        spinner.error(message);
        throw error;
      }
    },
  };
}
