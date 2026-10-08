import type { OutgoingMessage } from "../../contracts.ts";
import { message } from "../../loader.ts";

export type Button = { label: string; action: string };
/** A screen: renders with `outcome`, a pre-formatted first line, if given. */
export type Page = (outcome?: string) => Promise<OutgoingMessage>;
/** A value a screen asked for: the owner's next text, applied, then `then` shown with the outcome. */
export type Input = { secret: boolean; apply: (text: string) => Promise<string>; then: Page };
export type Nav = ReturnType<typeof createNav>;

/** Buttons per page of a list. */
const PAGE = 8;
/** Actions kept; older buttons expire. */
const KEEP = 500;
const NOT_CHANGED = "Not changed: ";

/** A reply as an outcome line: `Not changed: X` becomes `✗ X`, anything else `✓ <reply>`. */
export function outcomeLine(reply: string): string {
  return reply.startsWith(NOT_CHANGED) ? `✗ ${reply.slice(NOT_CHANGED.length)}` : `✓ ${reply}`;
}

/** An age of `ms`: `<1m`, then whole minutes `Nm`, hours `Nh` under 48 hours, then days `Nd`. */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * Screens with buttons for one command's menu (`scope` "s" for /settings, "j" for /jobs). Each button's action,
 * `<run>:<scope>:<n>`, maps in memory to what pressing it shows; the newest `KEEP` are kept. A button remembers the
 * screen it was made on, where an error pressing it is shown as `✗ <message>`.
 */
export function createNav(scope: "s" | "j", run: string) {
  let next = 0;
  let shown: Page | undefined; // the screen being rendered: the origin of the buttons made meanwhile
  let input: Input | undefined;
  const actions = new Map<string, { open: () => Promise<OutgoingMessage>; from?: Page }>();
  const register = (label: string, open: () => Promise<OutgoingMessage>): Button => {
    const action = `${run}:${scope}:${++next}`;
    actions.set(action, { open, from: shown });
    if (actions.size > KEEP) actions.delete(actions.keys().next().value!);
    return { label, action };
  };
  const failed = (error: unknown) => `✗ ${message(error)}`;

  const nav = {
    /** A button showing `page`. */
    button: (label: string, page: Page): Button => register(label, () => nav.show(page)),

    /** A button running `run`, then showing `then` with its reply (or error) as the outcome. */
    act: (label: string, run: () => Promise<string>, then: Page): Button =>
      register(label, async () => nav.show(then, await Promise.resolve().then(run).then(outcomeLine, failed))),

    /** `[outcome\n\n]**title**[\n\nbody]`, `rows`, then a footer row of `‹ Back` and `⌂ Home`, when given. */
    screen({ title, body, rows, back, home, outcome }: {
      title: string;
      body?: string;
      rows: Button[][];
      back?: Page;
      home?: Page;
      outcome?: string;
    }): OutgoingMessage {
      const markdown = [outcome, `**${title}**`, body].filter((p) => p !== undefined).join("\n\n");
      const footer = [];
      if (back !== undefined) footer.push(nav.button("‹ Back", back));
      if (home !== undefined) footer.push(nav.button("⌂ Home", home));
      return { markdown, buttons: footer.length > 0 ? [...rows, footer] : rows };
    },

    /** A screen of one button per item, `PAGE` to a page, with a row `‹` · `p/n` · `›` when there is more than one. */
    paged(options: {
      title: string;
      body?: string;
      items: (readonly [string, Page] | Button)[];
      page?: number;
      back?: Page;
      home?: Page;
      outcome?: string;
    }): OutgoingMessage {
      const { items, page: wanted = 0, ...rest } = options;
      const pages = Math.max(1, Math.ceil(items.length / PAGE));
      const page = Math.min(Math.max(wanted, 0), pages - 1);
      const at = (p: number): Page => async (outcome) => nav.paged({ ...options, page: p, outcome });
      const rows = items
        .slice(page * PAGE, (page + 1) * PAGE)
        .map((item) => [Array.isArray(item) ? nav.button(item[0], item[1]) : (item as Button)]);
      if (pages > 1) {
        const row = [];
        if (page > 0) row.push(nav.button("‹", at(page - 1)));
        row.push(nav.button(`${page + 1}/${pages}`, at(page)));
        if (page < pages - 1) row.push(nav.button("›", at(page + 1)));
        rows.push(row);
      }
      return nav.screen({ ...rest, rows });
    },

    /** Asks `question`, with `yes` running `run` then showing `then`, and `Cancel` showing `back`. */
    confirm: (question: string, yes: string, run: () => Promise<string>, then: Page, back: Page): Page =>
      async (outcome) =>
        nav.screen({ title: question, rows: [[nav.act(yes, run, then)], [nav.button("Cancel", back)]], outcome }),

    /**
     * Asks for a value, typed as the owner's next message, with `Cancel` showing `cancel`; `apply` gets it and
     * `then` is shown with its reply. A `secret` one is deleted at once.
     */
    ask: ({ title, prompt, secret = false, apply, then, cancel }: {
      title: string;
      prompt?: string;
      secret?: boolean;
      apply: (text: string) => Promise<string>;
      then: Page;
      cancel: Page;
    }): Page =>
      async (outcome) => {
        const send = "Send the new value as your next message.";
        const body = prompt === undefined ? send : `${prompt}\n\n${send}`;
        const shown = nav.screen({ title, body, rows: [[nav.button("Cancel", cancel)]], outcome });
        input = { secret, apply, then };
        return shown;
      },

    /** Renders `page`, the origin of the buttons it makes. */
    show(page: Page, outcome?: string): Promise<OutgoingMessage> {
      shown = page;
      return page(outcome);
    },

    /** What pressing `action` shows (an error on the button's own screen); undefined once it expired. */
    open(action: string): Promise<OutgoingMessage> | undefined {
      const entry = actions.get(action);
      if (entry === undefined) return undefined;
      return entry.open().catch((error) => {
        const outcome = failed(error);
        return entry.from === undefined ? { markdown: outcome } : nav.show(entry.from, outcome);
      });
    },

    /** The input a screen is waiting for, if any. */
    pending: (): Input | undefined => input,
    /** Stops waiting for `which` (the current input when not given). */
    cancel(which: Input | undefined = input) {
      if (input === which) input = undefined;
    },
  };
  return nav;
}
