import type { Context } from "@earendil-works/chord";
import type { Message, Models, ToolCall } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  HarnessOptions,
  ModelRef,
  TaskId,
} from "@earendil-works/pi-durable";
import type { SettingsUI } from "./settings.ts";

export type Dispose = () => void | Promise<void>;
export type Address = { channel: string; recipient: string };
export type Incoming = { id: string; address: Address; text: string };
export type Outgoing = { text: string };

export interface Channel {
  settings: SettingsUI;
  start(receive: (message: Incoming) => Promise<void>): Promise<Dispose>;
  /** Repeated keys identify the same delivery. Some transports cannot deduplicate. */
  send(
    address: Address,
    message: Outgoing,
    key: string,
    context: Context,
  ): Promise<void>;
}

export interface ModelProvider {
  models: Models;
  root: ModelRef;
  worker: ModelRef;
}

/** The native Pi Durable environment factory, not a second computer API. */
export type ExecutionEnvironment = NonNullable<HarnessOptions["env"]>;

export interface ContextProvider {
  assemble(
    messages: readonly Message[],
    context: Context,
  ): Promise<readonly Message[]>;
}

export type Memory = { text: string; revision: string };

/** A small reflective note, not a second history database. */
export interface MemoryProvider {
  read(context: Context): Promise<Memory>;
  /** Reject a stale revision rather than overwriting a newer reflection or user edit. */
  rewrite(text: string, revision: string, context: Context): Promise<Memory>;
}

export type JobBrief = {
  title: string;
  instructions: string;
  address: Address;
  commitmentId?: string;
};
export type Job = JobBrief & {
  id: string;
  taskId: TaskId;
  conversationId: ConversationId;
  status: "running" | "completed" | "failed" | "cancelled";
  result: string;
  createdAt: number;
  updatedAt: number;
};

export interface JobRunner {
  /** The caller supplies a stable key so retries cannot create another job. */
  start(brief: JobBrief, key: string, context: Context): Promise<Job>;
  list(context: Context): Promise<readonly Job[]>;
  search(
    query: string,
    limit: number,
    context: Context,
  ): Promise<readonly Job[]>;
  steer(
    id: string,
    message: string,
    key: string,
    context: Context,
  ): Promise<void>;
  cancel(id: string, context: Context): Promise<void>;
}

export type Action = {
  id: string;
  conversationId: ConversationId;
  call: ToolCall;
};
export type PolicyDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "ask"; reason: string };

export interface PolicyProvider {
  decide(action: Action, context: Context): Promise<PolicyDecision>;
}

export interface ApprovalProvider {
  request(action: Action, reason: string, context: Context): Promise<boolean>;
  resolve(
    id: string,
    approved: boolean,
    address: Address,
    context: Context,
  ): Promise<void>;
}

/** These are the eight slots. Extensions supply every implementation. */
export interface Adapters {
  channel: Channel;
  models: ModelProvider;
  environment: ExecutionEnvironment;
  context: ContextProvider;
  memory: MemoryProvider;
  jobs: JobRunner;
  policy: PolicyProvider;
  approvals: ApprovalProvider;
}
