import { Cancelled, type Choice, type Prompter } from "../src/cli/prompt.ts";

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

  function next(question: string, choices: Choice<unknown>[] = []): unknown {
    asked.push(question);
    const step = steps.shift();
    if (step === undefined) throw new Error(`unexpected question: "${question}"`);
    const [match, answer] = step;
    if (!question.includes(match)) throw new Error(`expected "${match}", got "${question}"`);
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
    async select<T>(question: string, choices: Choice<T>[]): Promise<T> {
      return next(question, choices as Choice<unknown>[]) as T;
    },
    async text(question: string): Promise<string> {
      return (next(question) as string).trim();
    },
    async secret(question: string): Promise<string> {
      return (next(question) as string).trim();
    },
    async confirm(question: string): Promise<boolean> {
      return next(question) as boolean;
    },
    done() {
      if (steps.length > 0) throw new Error(`done: ${steps.length} step(s) left`);
    },
  };
}
