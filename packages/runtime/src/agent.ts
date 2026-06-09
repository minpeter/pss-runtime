import type { ToolSet } from "ai";
import { cancelDurableChildRuns } from "./agent-child-runs";
import { supportsBackgroundSubagents } from "./agent-host-capabilities";
import { sessionStoreForHost } from "./agent-host-session-store";
import {
  parentSessionNamespace,
  stableAgentNamespace,
} from "./agent-namespace";
import {
  type AgentConstructionOptions,
  type AgentModelOptions,
  type AgentOptions,
  assertAgentOptions,
  hasLanguageModel,
  hasRuntimeModel,
} from "./agent-options";
import { resumeAgentRun } from "./agent-resume";
import type { AgentSessionEntry, SessionHandle } from "./agent-session-entry";
import { assertSubagents } from "./agent-validation";
import { ChildSessionCleanups } from "./child-session-cleanups";
import { executionHost } from "./execution/host";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { AgentHost, NotificationRecord } from "./execution/types";
import { createLlm, type RuntimeLlm } from "./llm";
import type { AgentPlugin } from "./plugins";
import type { UserInput } from "./session/events";
import type { AgentRun } from "./session/run";
import {
  type AgentInput,
  AgentSession,
  type NotifyOptions,
} from "./session/session";
import type { SessionStore } from "./session/store/types";
import { type RegisteredSubagent, registerSubagents } from "./subagent-register";
import { createSubagentTools } from "./subagents";

export type { AgentOptions } from "./agent-options";
export type { SessionHandle } from "./agent-session-entry";
export type { AgentHost } from "./execution/types";

export class Agent {
  readonly #baseTools?: ToolSet;
  readonly #llm?: RuntimeLlm;
  readonly #modelOptions?: AgentModelOptions;
  readonly #childSessionCleanups = new ChildSessionCleanups();
  readonly #sessionGenerations = new Map<string, number>();
  readonly #sessions = new Map<string, AgentSessionEntry>();
  readonly #sessionNamespace: string;
  readonly #store: SessionStore;
  readonly #host: AgentHost;
  readonly #plugins: readonly AgentPlugin[];
  readonly #subagents: readonly RegisteredSubagent[];
  readonly description?: string;
  readonly host: AgentHost;
  readonly name?: string;
  readonly subagentCount: number;
  readonly wrapDelegatePrompt?: (input: AgentInput) => AgentInput;

  constructor(options: AgentConstructionOptions) {
    assertAgentOptions(options);

    this.description = options.description;
    this.name = options.name;
    this.wrapDelegatePrompt =
      "wrapDelegatePrompt" in options
        ? options.wrapDelegatePrompt
        : undefined;
    this.#sessionNamespace = stableAgentNamespace({
      name: options.name,
      namespace: options.namespace,
    });
    this.#host = options.host ?? createInMemoryExecutionHost();
    this.host = this.#host;
    this.#store = sessionStoreForHost(this.#host);
    this.#plugins = options.plugins ?? [];
    if (options.subagents !== undefined) {
      assertSubagents(options, Agent, hasRuntimeModel(options));
      this.#subagents = registerSubagents(options.subagents);
    } else {
      this.#subagents = [];
    }
    this.subagentCount = this.#subagents.length;
    if (hasRuntimeModel(options)) {
      this.#llm = options.model;
    } else if (hasLanguageModel(options)) {
      this.#baseTools = options.tools;
      this.#modelOptions = {
        instructions: options.instructions,
        model: options.model,
        toolChoice: options.toolChoice,
      };
    }
  }

  send(input: AgentInput): Promise<AgentRun> {
    return this.session("default").send(input);
  }

  async resume(runId: string): Promise<AgentRun | null> {
    const host = executionHost(this.#host);
    if (!host) {
      throw new Error("Agent host does not support durable run resume.");
    }

    return await resumeAgentRun({
      host,
      ownerNamespace: this.#sessionNamespace,
      resumeNotification: (notification) =>
        this.#resumeNotification(notification),
      runId,
      subagents: this.#subagents,
    });
  }

  session(key: string): SessionHandle {
    return this.#sessionEntry(key).publicHandle;
  }

  #sessionEntry(key: string): AgentSessionEntry {
    const existing = this.#sessions.get(key);
    if (existing) {
      return existing;
    }

    let session: AgentSession | undefined;
    const getSession = () => {
      if (!session) {
        throw new Error("Agent session is not initialized.");
      }
      return session;
    };
    const parentAgentNamespace = parentSessionNamespace({
      generation: this.#sessionGenerations.get(key) ?? 0,
      sessionKey: key,
      sessionNamespace: this.#sessionNamespace,
    });
    const llm =
      this.#llm ??
      createLlm(
        this.#createLlmOptionsForSession(
          key,
          parentAgentNamespace,
          (input: UserInput, placement?: "turn-start") =>
            getSession().enqueueRuntimeInput(input, placement),
          (event) => getSession().emitObserverEvent(event),
          (input: UserInput, options?: NotifyOptions) =>
            getSession().notify(input, options),
          () => getSession().currentTurnId(),
          () => parentAgentNamespace
        )
      );
    session = new AgentSession(
      llm,
      { key, store: this.#store },
      this.#plugins,
      {
        executionHost: executionHost(this.#host),
      }
    );
    const publicHandle: SessionHandle = {
      delete: async () => {
        session.kill();
        await this.#cancelDurableChildRunsBeforeLocalCleanup(
          key,
          parentAgentNamespace
        );
        this.#evictSessionHandle(key);
        await session.delete();
        await this.#childSessionCleanups.delete(key);
      },
      interrupt: () => session.interrupt(),
      kill: async () => {
        session.kill();
        await this.#cancelDurableChildRunsBeforeLocalCleanup(
          key,
          parentAgentNamespace
        );
        this.#evictSessionHandle(key);
        await this.#childSessionCleanups.delete(key);
      },
      send: (input) => session.send(input),
      steer: (input) => session.steer(input),
    };
    const entry: AgentSessionEntry = {
      notify: (input, options) => session.notify(input, options),
      publicHandle,
    };
    this.#sessions.set(key, entry);
    return entry;
  }

  async #cancelDurableChildRunsBeforeLocalCleanup(
    key: string,
    parentAgentNamespace: string
  ): Promise<void> {
    try {
      await cancelDurableChildRuns(this.#host, parentAgentNamespace);
    } catch (error) {
      this.#evictSessionHandle(key);
      throw error;
    }
  }

  #evictSessionHandle(key: string): void {
    this.#sessions.delete(key);
    this.#sessionGenerations.set(
      key,
      (this.#sessionGenerations.get(key) ?? 0) + 1
    );
  }

  #resumeNotification(notification: NotificationRecord): Promise<AgentRun> {
    return this.#sessionEntry(notification.sessionKey).notify(
      notification.input,
      { observerEvents: notification.observerEvents }
    );
  }

  #createLlmOptionsForSession(
    key: string,
    parentAgentNamespace: string,
    enqueueRuntimeInput: AgentSession["enqueueRuntimeInput"],
    emitObserverEvent: AgentSession["emitObserverEvent"],
    notify: (input: UserInput, options?: NotifyOptions) => Promise<AgentRun>,
    currentBackgroundGroupId: () => string | undefined,
    currentRunId: () => string | undefined
  ): Parameters<typeof createLlm>[0] {
    const modelOptions = this.#modelOptions;
    if (!modelOptions) {
      throw new Error("Agent: missing model options.");
    }
    const hostExecution = executionHost(this.#host);
    const tools =
      this.#subagents.length === 0
        ? this.#baseTools
        : {
            ...this.#baseTools,
            ...createSubagentTools({
              backgroundSubagents: supportsBackgroundSubagents(
                this.#host,
                hostExecution
              ),
              executionHost: hostExecution,
              parentAgentNamespace,
              parentSession: {
                currentBackgroundGroupId,
                currentRunId,
                emitObserverEvent,
                enqueueRuntimeInput,
                notify,
              },
              parentSessionKey: key,
              registerChildSession: (sessionKey, cleanup) =>
                this.#childSessionCleanups.register(sessionKey, cleanup),
              subagents: this.#subagents,
            }),
          };

    return {
      instructions: modelOptions.instructions,
      model: modelOptions.model,
      toolChoice: modelOptions.toolChoice,
      tools,
    };
  }
}
