import type { Context } from "@earendil-works/chord";

/** Setup is UI, not conversation: answers must never enter the model transcript. */
export type SettingsPrompt =
  | {
      kind: "choice";
      title: string;
      choices: readonly { value: string; label: string }[];
      defaultValue?: string;
    }
  | {
      kind: "text";
      title: string;
      /** Sensitive input: keep out of conversation, mask/delete where possible. */
      secret?: boolean;
      defaultValue?: string;
    };

/** Every channel renders this protocol; disclose transport privacy limits for secrets. */
export interface SettingsUI {
  prompt(
    request: SettingsPrompt,
    context: Context,
  ): Promise<string | undefined>;
  notify(message: string, context: Context): Promise<void>;
}
