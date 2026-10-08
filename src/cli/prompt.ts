import {
  type Component,
  decodeKittyPrintable,
  Input,
  matchesKey,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";

/** One option offered by `Prompter.select`. */
export type Choice<T> = { label: string; value: T; hint?: string };

/** Thrown when the user cancels a prompt (Esc or Ctrl-C). */
export class Cancelled extends Error {}

/** The setup wizard's questions, answered by a real terminal (`tuiPrompter`) or a script (tests). */
export type Prompter = {
  note(text: string): void;
  select<T>(question: string, choices: Choice<T>[], initial?: T): Promise<T>;
  text(question: string, opts?: { initial?: string; help?: string }): Promise<string>; // trimmed
  secret(question: string, help?: string): Promise<string>; // trimmed; "" = keep/skip
  confirm(question: string, initial: boolean): Promise<boolean>;
};

/** An `Input` that shows each typed character as `•`. */
export class MaskedInput extends Input {
  override render(width: number): string[] {
    const value = this.getValue();
    this.setValue("•".repeat(value.length)); // same length: the cursor stays put
    const lines = super.render(width);
    this.setValue(value);
    return lines;
  }
}

/** An `Input` showing `prompt`, holding `value` with the cursor after it, so typing appends and Backspace deletes
 * (`setValue` alone leaves the cursor at 0, and pi-tui has no cursor setter: press End instead). */
export function prefilledInput(prompt: string, value: string): Input {
  const input = new Input({ prompt });
  input.setValue(value);
  input.handleInput("\x1b[F"); // End
  return input;
}

const plain = (s: string) => s;
const selectTheme: SelectListTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

/**
 * A `SelectList` with its question rendered above it. `SelectList` itself only handles
 * up/down/enter; any other character narrows the choices by prefix, backspace undoes that.
 */
export class FilterableSelectList implements Component {
  private readonly question: string;
  private readonly list: SelectList;
  private filter = "";
  onSelect?: (item: SelectItem) => void;

  constructor(question: string, items: SelectItem[]) {
    this.question = question;
    this.list = new SelectList(items, 10, selectTheme);
    this.list.onSelect = (item) => this.onSelect?.(item);
  }

  setSelectedIndex(index: number): void {
    this.list.setSelectedIndex(index);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const filterLine = this.filter === "" ? [] : [`  (filter: ${this.filter})`];
    return [this.question, ...filterLine, ...this.list.render(width)];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter")) {
      this.list.handleInput(data);
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.filter = this.filter.slice(0, -1);
    } else {
      // The Kitty keyboard protocol (active in kitty, WezTerm, Ghostty, foot, etc. -- pi-tui's
      // ProcessTerminal queries for and enables it on startup) reports every key, including plain
      // printable characters, as a CSI-u escape sequence (e.g. "\x1b[97u" for "a"), so a bare
      // `data.length === 1` check silently drops all typed filter characters under it. Decode the
      // same way pi-tui's own `Input`/`Editor` do before falling back to the plain, non-Kitty case.
      const printable = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
      if (printable === undefined) return;
      this.filter += printable;
    }
    this.list.setFilter(this.filter);
  }
}

/** A `Prompter` backed by a real terminal. `close()` stops the TUI; callers close in `finally`. */
export function tuiPrompter(): Prompter & { close(): void } {
  const tui = new TuiMainScreen(new ProcessTerminal());
  const history = new Text("", 1, 0);
  const lines: string[] = [];
  tui.addChild(history);

  // One question is live at a time; Esc/Ctrl-C cancel it regardless of which component is focused.
  let cancelCurrent: (() => void) | undefined;
  const removeCancelListener = tui.addInputListener((data) => {
    if (!matchesKey(data, "escape") && !matchesKey(data, "ctrl+c")) return undefined;
    if (cancelCurrent === undefined) return undefined;
    cancelCurrent();
    return { consume: true };
  });

  tui.start();

  const record = (line: string) => {
    lines.push(line);
    history.setText(lines.join("\n"));
    tui.requestRender();
  };

  /** Shows `component` focused until `wire` calls back with its result; always removes it after. */
  function run<T>(component: Component, wire: (resolve: (value: T) => void) => void): Promise<T> {
    tui.addChild(component);
    tui.setFocus(component);
    tui.requestRender();
    return new Promise<T>((resolve, reject) => {
      cancelCurrent = () => reject(new Cancelled());
      wire(resolve);
    }).finally(() => {
      cancelCurrent = undefined;
      tui.removeChild(component);
      tui.setFocus(null);
      tui.requestRender();
    });
  }

  async function select<T>(question: string, choices: Choice<T>[], initial?: T): Promise<T> {
    const byItem = new Map<SelectItem, Choice<T>>();
    const items = choices.map((choice) => {
      const item: SelectItem = { value: choice.label, label: choice.label, description: choice.hint };
      byItem.set(item, choice);
      return item;
    });
    const component = new FilterableSelectList(question, items);
    const initialIndex = initial === undefined ? -1 : choices.findIndex((c) => c.value === initial);
    if (initialIndex >= 0) component.setSelectedIndex(initialIndex);
    const item = await run<SelectItem>(component, (resolve) => {
      component.onSelect = resolve;
    });
    const choice = byItem.get(item)!;
    record(`${question} ${choice.label}`);
    return choice.value;
  }

  async function text(question: string, opts?: { initial?: string; help?: string }): Promise<string> {
    const prompt = opts?.help ? `${question} (${opts.help}): ` : `${question}: `;
    const input = prefilledInput(prompt, opts?.initial ?? "");
    const value = (
      await run<string>(input, (resolve) => {
        input.onSubmit = resolve;
      })
    ).trim();
    record(`${prompt}${value}`);
    return value;
  }

  async function secret(question: string, help?: string): Promise<string> {
    const prompt = help ? `${question} (${help}): ` : `${question}: `;
    const input = new MaskedInput({ prompt });
    const value = (
      await run<string>(input, (resolve) => {
        input.onSubmit = resolve;
      })
    ).trim();
    record(`${prompt}${"•".repeat(value.length)}`);
    return value;
  }

  async function confirm(question: string, initial: boolean): Promise<boolean> {
    return select(
      `${question} ${initial ? "[Y/n]" : "[y/N]"}`,
      [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ],
      initial,
    );
  }

  return {
    note: record,
    select,
    text,
    secret,
    confirm,
    close() {
      removeCancelListener();
      tui.stop();
    },
  };
}
