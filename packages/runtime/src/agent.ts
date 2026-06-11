import { sessionStoreForHost } from "./agent-host-session-store";
import { stableAgentNamespace } from "./agent-namespace";
import {
  type AgentConstructionOptions,
  type AgentModelOptions,
  assertAgentOptions,
} from "./agent-options";
import { resumeAgentRun } from "./agent-resume";
import type { AgentSessionEntry, SessionHandle } from "./agent-session-entry";
import { executionHost } from "./execution/host";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { AgentHost, NotificationRecord } from "./execution/types";
import type { AgentPlugin } from "./plugins";
import type { AgentRun } from "./session/run";
import { type AgentInput, AgentSession } from "./session/session";
import type { SessionStore } from "./session/store/types";

export type { AgentOptions } from "./agent-options";
export type { SessionHandle } from "./agent-session-entry";
export type { AgentHost } from "./execution/types";

export class Agent {
  readonly #modelOptions: AgentModelOptions;
  readonly #sessions = new Map<string, AgentSessionEntry>();
  readonly #sessionNamespace: string;
  readonly #store: SessionStore;
  readonly #host: AgentHost;
  readonly #plugins: readonly AgentPlugin[];
  readonly host: AgentHost;
  readonly namespace?: string;
  constructor(options: AgentConstructionOptions) {
    assertAgentOptions(options);

    this.namespace = options.namespace;
    this.#sessionNamespace = stableAgentNamespace({
      namespace: options.namespace,
    });
    this.#host = options.host ?? createInMemoryExecutionHost();
    this.host = this.#host;
    this.#store = sessionStoreForHost(this.#host);
    this.#plugins = options.plugins ?? [];
    this.#modelOptions = {
      instructions: options.instructions,
      model: options.model,
      toolChoice: options.toolChoice,
      tools: options.tools,
    };
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
    session = new AgentSession(
      this.#modelOptions,
      { key, store: this.#store },
      this.#plugins,
      {
        executionHost: executionHost(this.#host),
      }
    );
    const publicHandle: SessionHandle = {
      delete: async () => {
        session.kill();
        this.#evictSessionHandle(key);
        await session.delete();
      },
      dispose: () => {
        session.kill();
        this.#evictSessionHandle(key);
        return Promise.resolve();
      },
      interrupt: () => session.interrupt(),
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

  #evictSessionHandle(key: string): void {
    this.#sessions.delete(key);
  }

  #resumeNotification(notification: NotificationRecord): Promise<AgentRun> {
    return this.#sessionEntry(notification.sessionKey).notify(
      notification.input,
      { observerEvents: notification.observerEvents }
    );
  }
}
