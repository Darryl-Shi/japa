import { Cancelled, type Choice, type Prompter } from "../src/cli/prompt.ts";

/** A scripted answer that presses Enter: the prompt's preselected/prefilled value (a confirm's default, a select's
 * initial or first choice, a text's prefill), or "" for an empty text or secret. */
export const ENTER = Symbol("enter");

/**
 * A `Prompter` driven by a script: each call takes the next `[match, answer]` step, asserts its
 * question includes `match`, and returns `answer` (calling it with the offered choices first, if
 * it's a function). An answer of `"cancel"` throws `Cancelled`, as a real prompt would on Esc.
 */
export function scripted(
  steps: [match: string, answer: unknown | ((choices: Choice<unknown>[]) => unknown)][],
): Prompter & { asked: string[]; notes: string[]; done(): void } {
  const asked: string[] = [];
  const notes: string[] = [];

  function next(question: string, choices: Choice<unknown>[] = [], initial?: unknown): unknown {
    asked.push(question);
    const step = steps.shift();
    if (step === undefined) throw new Error(`unexpected question: "${question}"`);
    const [match, answer] = step;
    if (!question.includes(match)) throw new Error(`expected "${match}", got "${question}"`);
    if (answer === ENTER) return initial ?? choices[0]?.value ?? "";
    const resolved = typeof answer === "function" ? (answer as (choices: Choice<unknown>[]) => unknown)(choices) : answer;
    if (resolved === "cancel") throw new Cancelled();
    return resolved;
  }

  return {
    asked,
    notes,
    note(text) {
      notes.push(text);
    },
    async select<T>(question: string, choices: Choice<T>[], initial?: T): Promise<T> {
      return next(question, choices as Choice<unknown>[], initial) as T;
    },
    async text(question: string, opts?: { initial?: string }): Promise<string> {
      return (next(question, [], opts?.initial) as string).trim();
    },
    async secret(question: string): Promise<string> {
      return (next(question) as string).trim();
    },
    async confirm(question: string, initial: boolean): Promise<boolean> {
      return next(question, [], initial) as boolean;
    },
    done() {
      if (steps.length > 0) throw new Error(`done: ${steps.length} step(s) left`);
    },
  };
}
