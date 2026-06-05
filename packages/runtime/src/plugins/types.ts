import type { ModelMessage, ToolSet } from "ai";
import type { UserInput } from "../session/events";
import type { AgentInput } from "../session/input";
import type { AgentRun } from "../session/run";
import type { SessionStore } from "../session/store/types";

export type AgentPluginMaybePromise<T> = Promise<T> | T;

export type AgentContextTransform = (context: {
  readonly history: readonly ModelMessage[];
  readonly sessionKey: string;
  readonly signal: AbortSignal;
}) => AgentPluginMaybePromise<readonly ModelMessage[]>;

export const AGENT_PLUGIN_EVENT_NAMES = [
  "turn.before",
  "step.before",
  "step.after",
  "turn.after",
  "tool.call",
  "tool.result",
] as const;

export type AgentPluginEventName = (typeof AGENT_PLUGIN_EVENT_NAMES)[number];

export type AgentPluginStepResult = "completed" | "continue";
export type AgentPluginToolResultStatus = "cancelled" | "done" | "error";
export type AgentPluginTurnResult = "aborted" | "completed";
type AgentPluginNoResult = ReturnType<() => void>;

export interface AgentPluginToolSyntheticResult {
  readonly exitCode?: number;
  readonly output: unknown;
}

export type AgentPluginToolCallResult =
  | AgentPluginNoResult
  | { readonly action: "allow" }
  | { readonly action: "error"; readonly message: string }
  | { readonly action: "modify"; readonly input: unknown }
  | { readonly action: "reject-and-continue"; readonly message: string }
  | {
      readonly action: "synthesize";
      readonly result: AgentPluginToolSyntheticResult;
    };

export type AgentPluginToolResultResult =
  | AgentPluginNoResult
  | {
      readonly error?: string;
      readonly output?: unknown;
      readonly status: AgentPluginToolResultStatus;
    };

interface AgentPluginBaseEvent {
  readonly history: readonly ModelMessage[];
  readonly overlay: (input: AgentInput) => Promise<AgentRun>;
  readonly sessionKey: string;
  readonly signal: AbortSignal;
  readonly steer: (input: AgentInput) => Promise<AgentRun>;
  readonly type: AgentPluginEventName;
}

export interface AgentPluginTurnBeforeEvent extends AgentPluginBaseEvent {
  readonly input: UserInput;
  readonly type: "turn.before";
}

export interface AgentPluginStepBeforeEvent extends AgentPluginBaseEvent {
  readonly stepIndex: number;
  readonly type: "step.before";
}

export interface AgentPluginStepAfterEvent extends AgentPluginBaseEvent {
  readonly result: AgentPluginStepResult;
  readonly stepIndex: number;
  readonly type: "step.after";
}

export interface AgentPluginTurnAfterEvent extends AgentPluginBaseEvent {
  readonly input: UserInput;
  readonly result: AgentPluginTurnResult;
  readonly type: "turn.after";
}

export interface AgentPluginToolCallEvent extends AgentPluginBaseEvent {
  readonly input: unknown;
  readonly tool: string;
  readonly toolCallId: string;
  readonly type: "tool.call";
}

export interface AgentPluginToolResultEvent extends AgentPluginBaseEvent {
  readonly elapsedMs?: number;
  readonly error?: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly status: AgentPluginToolResultStatus;
  readonly tool: string;
  readonly toolCallId: string;
  readonly type: "tool.result";
}

export type AgentPluginEvent =
  | AgentPluginStepAfterEvent
  | AgentPluginStepBeforeEvent
  | AgentPluginToolCallEvent
  | AgentPluginToolResultEvent
  | AgentPluginTurnAfterEvent
  | AgentPluginTurnBeforeEvent;

export type AgentPluginEventFor<Name extends AgentPluginEventName> = Extract<
  AgentPluginEvent,
  { readonly type: Name }
>;

export type AgentPluginHandlerResult<Event extends AgentPluginEvent> =
  Event extends AgentPluginToolCallEvent
    ? AgentPluginToolCallResult
    : Event extends AgentPluginToolResultEvent
      ? AgentPluginToolResultResult
      : AgentPluginNoResult;

export type AgentPluginHandlerReturn<Event extends AgentPluginEvent> =
  Event extends AgentPluginToolCallEvent
    ? AgentPluginMaybePromise<AgentPluginToolCallResult>
    : Event extends AgentPluginToolResultEvent
      ? AgentPluginMaybePromise<AgentPluginToolResultResult>
      : AgentPluginMaybePromise<void>;

export type AgentPluginHandler<
  Event extends AgentPluginEvent = AgentPluginEvent,
> = (event: Event) => AgentPluginHandlerReturn<Event>;

export type AgentPluginStoredHandler<
  Event extends AgentPluginEvent = AgentPluginEvent,
> = {
  bivarianceHack(event: Event): AgentPluginHandlerReturn<Event>;
}["bivarianceHack"];

export interface AgentPlugin {
  readonly name: string;
  setup(host: AgentPluginHost): AgentPluginMaybePromise<void>;
}

export interface AgentPluginHost {
  on<Name extends AgentPluginEventName>(
    event: Name,
    handler: AgentPluginHandler<AgentPluginEventFor<Name>>
  ): void;
  registerSessionStore(store: SessionStore): void;
  registerTools(tools: ToolSet): void;
  transformContext(handler: AgentContextTransform): void;
}

export function definePlugin(plugin: AgentPlugin): AgentPlugin {
  return plugin;
}

const agentPluginEventNameSet: ReadonlySet<string> = new Set(
  AGENT_PLUGIN_EVENT_NAMES
);

export function isAgentPluginEventName(
  event: unknown
): event is AgentPluginEventName {
  return typeof event === "string" && agentPluginEventNameSet.has(event);
}
