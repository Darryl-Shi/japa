import type { Incoming, MessagingAdapter, MessagingAdapterContext, OutgoingMessage } from "../src/kernel/contracts.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { bootTest, testKit } from "./helpers.ts";

type Buttons = OutgoingMessage["buttons"];
type Input = OutgoingMessage["input"];

/**
 * A messaging adapter that records what the kernel sends; `receive` hands it a message (chat and user "42", a fresh
 * id and messageId unless given), `press` the button labelled `label` in the sent message `id`, else in the newest
 * sent or edited message.
 * `holdSends` holds each send until the adapter stops, then fails it; `held` tells that a send is being held.
 */
export function fakeAdapter({ name = "fake", maxMessageChars = 4096 } = {}) {
  let receive!: MessagingAdapterContext["receive"];
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  let count = 0;
  let newest: { id: string; buttons?: Buttons } | undefined;
  const fake = {
    sent: [] as { chat: string; id: string; markdown: string; buttons?: Buttons; input?: Input }[],
    edited: [] as { chat: string; messageId: string; markdown: string; buttons?: Buttons; input?: Input }[],
    deleted: [] as { chat: string; messageId: string }[],
    typing: [] as string[],
    commands: [] as { name: string; description: string }[][],
    failSend: undefined as ((m: OutgoingMessage) => boolean) | undefined,
    failDelete: false,
    holdSends: false,
    held: false,
    receive: (m: Partial<Incoming>) => {
      const n = String(++count);
      return receive({ chat: "42", user: "42", id: n, messageId: n, ...m });
    },
    press: (label: string, id?: string) => {
      const target = id === undefined ? newest! : fake.sent.find((s) => s.id === id)!;
      const action = target.buttons!.flat().find((b) => b.label === label)!.action;
      return fake.receive({ action, messageId: target.id });
    },
  };
  const adapter: MessagingAdapter = {
    name,
    maxMessageChars,
    start: async (c) => {
      receive = c.receive;
      return stop;
    },
    send: async (chat, m) => {
      if (fake.holdSends) {
        fake.held = true;
        await stopped;
        throw new Error("stopped");
      }
      if (fake.failSend?.(m)) throw new Error("send failed");
      const id = String(fake.sent.length + 1);
      fake.sent.push({ chat, id, ...m });
      newest = { id, buttons: m.buttons };
      return id;
    },
    edit: async (chat, messageId, m) => {
      fake.edited.push({ chat, messageId, ...m });
      newest = { id: messageId, buttons: m.buttons };
    },
    delete: async (chat, messageId) => {
      if (fake.failDelete) throw new Error("delete failed");
      fake.deleted.push({ chat, messageId });
    },
    typing: async (chat) => {
      fake.typing.push(chat);
    },
    commands: async (list) => {
      fake.commands.push(list);
    },
  };
  const extension: JapaExtension = { name, summary: "Fake chat", provides: { messaging: [adapter] } };
  return Object.assign(fake, { adapter, extension });
}

/** Boots with `fake` (owner "42" unless `settings` replaces `extensions`) and the `extra` extensions. */
export function bootMessaging(
  fake: ReturnType<typeof fakeAdapter>,
  settings: object = {},
  extra: JapaExtension[] = [],
  kit = testKit(),
) {
  return bootTest({ extensions: { [fake.adapter.name]: { owner: "42" } }, ...settings }, [fake.extension, ...extra], kit);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
