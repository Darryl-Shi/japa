// Public API for extension authors, imported as "japa/sdk".
export {
  defineDoc,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  section,
  ToolTask,
  wrapTool,
} from "@earendil-works/pi-durable";
export { Type } from "@earendil-works/pi-ai";
export type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
// For a `provider` contribution: pi-ai's provider builder, API key auth, the API implementations (each loaded on first
// use), and what wrapping their streams takes (to retry, say).
export {
  createAssistantMessageEventStream,
  createProvider,
  envApiKeyAuth,
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
export { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
export { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
export { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  Provider,
  ProviderStreams,
  RefreshModelsContext,
  SimpleStreamOptions,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
export { logChange } from "./kernel/changes.ts";
export type {
  BootContext,
  Dispose,
  EnvironmentAdapter,
  Incoming,
  IncomingFile,
  KernelContext,
  MessagingAdapter,
  MessagingAdapterContext,
  Origin,
  OutgoingFile,
  OutgoingMessage,
  Reply,
  SecretsAdapter,
  SecretsStore,
  StorageAdapter,
  Status,
  Surface,
  SurfaceContext,
  Trigger,
  TriggerContext,
} from "./kernel/contracts.ts";
export { defineJapaExtension } from "./kernel/extension.ts";
export { board, JobDoc, JobsDoc } from "./kernel/jobs/state.ts";
export { splitMessage } from "./kernel/messaging/split.ts";
export type { Job } from "./kernel/jobs/state.ts";
export type { SecretRequest } from "./kernel/secret-requests.ts";
export type { Authorize, AuthorizeContext, JapaExtension } from "./kernel/extension.ts";
