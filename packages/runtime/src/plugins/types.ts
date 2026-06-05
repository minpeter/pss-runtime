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

export type AgentPluginEventName =
  | "afterTurn"
  | "afterStep"
  | "beforeStep"
  | "beforeTurn";

export type AgentPluginStepResult = "completed" | "continue";
export type AgentPluginTurnResult = "aborted" | "completed";

interface AgentPluginBaseEvent {
  readonly history: readonly ModelMessage[];
  readonly sessionKey: string;
  readonly signal: AbortSignal;
  readonly steer: (input: AgentInput) => Promise<AgentRun>;
  readonly type: AgentPluginEventName;
}

export interface AgentPluginBeforeTurnEvent extends AgentPluginBaseEvent {
  readonly input: UserInput;
  readonly type: "beforeTurn";
}

export interface AgentPluginBeforeStepEvent extends AgentPluginBaseEvent {
  readonly stepIndex: number;
  readonly type: "beforeStep";
}

export interface AgentPluginAfterStepEvent extends AgentPluginBaseEvent {
  readonly result: AgentPluginStepResult;
  readonly stepIndex: number;
  readonly type: "afterStep";
}

export interface AgentPluginAfterTurnEvent extends AgentPluginBaseEvent {
  readonly input: UserInput;
  readonly result: AgentPluginTurnResult;
  readonly type: "afterTurn";
}

export type AgentPluginEvent =
  | AgentPluginAfterStepEvent
  | AgentPluginAfterTurnEvent
  | AgentPluginBeforeStepEvent
  | AgentPluginBeforeTurnEvent;

export type AgentPluginEventFor<Name extends AgentPluginEventName> = Extract<
  AgentPluginEvent,
  { readonly type: Name }
>;

export type AgentPluginHandler<
  Event extends AgentPluginEvent = AgentPluginEvent,
> = (event: Event) => AgentPluginMaybePromise<void>;

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
