import type { ModelMessage, ToolSet } from "ai";
import type { ThreadCompactionInput } from "../thread/state/thread-state";
import type {
  InputAcceptEvent,
  PluginCapability,
  PluginEventMap,
  PluginHandler,
  Subscription,
} from "./api";
import type { RuntimeDiagnosticsSink } from "./diagnostics";

export interface PluginRuntimeOptions {
  readonly diagnostics: RuntimeDiagnosticsSink;
  readonly factoryTimeoutMs: number;
  readonly hookTimeoutMs: number;
  readonly tools?: ToolSet;
}

export type PluginInputDecision = InputAcceptEvent | "handled";

export type PluginToolExecutionDecision =
  | { readonly status: "blocked"; readonly output: unknown }
  | { readonly input: unknown; readonly status: "continue" }
  | { readonly status: "needs-recovery" }
  | undefined;

export interface PluginCompactionDecision {
  readonly cancelled: boolean;
  readonly input: ThreadCompactionInput;
}

export interface RegisteredHandler {
  active: boolean;
  readonly event: keyof PluginEventMap;
  readonly handler: PluginHandler<keyof PluginEventMap>;
}

export interface PluginRegistration {
  readonly handlers: RegisteredHandler[];
  readonly index: number;
  state: "active" | "disposed" | "loading";
  readonly subscriptions: Subscription[];
  readonly tools: Map<string, PluginCapability & { readonly kind: "tool" }>;
}

export interface PluginInvocationContext {
  readonly history: readonly ModelMessage[];
  readonly signal: AbortSignal;
  readonly threadKey: string;
}

export type PluginFailureReporter = (
  pluginIndex: number,
  phase: "factory" | "handler",
  cause: unknown,
  event?: string
) => Promise<void>;

export interface PluginRuntimeState {
  readonly abort: AbortController;
  readonly diagnostics: RuntimeDiagnosticsSink;
  readonly hookTimeoutMs: number;
  readonly registrations: PluginRegistration[];
  readonly reportPluginFailure: PluginFailureReporter;
  readonly threadStateClearers: Set<(key: string) => void>;
  readonly tools: ToolSet;
}
