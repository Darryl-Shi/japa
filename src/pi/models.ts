// A model slot from settings, as pi runs it: the model, and the thinking level it runs at (clamped to what the model
// supports; "off" when the slot sets none).
import { clampThinkingLevel, type Models, type ModelThinkingLevel, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelChoice } from "../settings.ts";

export function thinkingOf(models: Models, choice: ModelChoice | undefined): ModelThinkingLevel {
	const model = choice === undefined ? undefined : models.getModel(choice.provider, choice.modelId);
	if (model === undefined || choice?.thinking === undefined) return "off";
	return clampThinkingLevel(model, choice.thinking as ModelThinkingLevel);
}

/** For a one-off call on it (a review, a summary): its reasoning, when it thinks. */
export function reasoningOf(models: Models, choice: ModelChoice | undefined): { reasoning?: ThinkingLevel } {
	const level = thinkingOf(models, choice);
	return level === "off" ? {} : { reasoning: level };
}

/** What a conversation stores as its model: the slot without its thinking level, which it stores apart. */
export const modelRef = (choice: ModelChoice) => ({ provider: choice.provider, modelId: choice.modelId });
