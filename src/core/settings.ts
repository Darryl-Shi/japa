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
      secret?: boolean;
      defaultValue?: string;
    };

/** Every channel supplies its own rendering, including secret input and cancellation. */
export interface SettingsUI {
  prompt(
    request: SettingsPrompt,
    context: Context,
  ): Promise<string | undefined>;
  notify(message: string, context: Context): Promise<void>;
}
