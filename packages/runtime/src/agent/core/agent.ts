import { executionHost } from "../../execution/host/host";
import type { AgentHost, NotificationRecord } from "../../execution/host/types";
import { createInMemoryExecutionHost } from "../../execution/memory";
import { type AgentInput, AgentSession } from "../../session/handle/session";
import type { AgentPlugin } from "../../session/plugins/pipeline";
import type { AgentRun } from "../../session/protocol/run";
import type { SessionStore } from "../../session/store/types";
import { stableAgentNamespace } from "../identity/namespace";
import { resumeAgentRun } from "../resume/resume";
import { sessionStoreForHost } from "./host-session-store";
import {
  type AgentModelOptions,
  type AgentOptions,
  assertAgentOptions,
} from "./options";
import {
  type AgentThreadEntry,
  type ThreadHandle,
  type ThreadKey,
  threadSessionKey,
} from "./thread-entry";

export type { AgentHost } from "../../execution/host/types";
export type { AgentOptions } from "./options";
export type {
  ThreadAddress,
  ThreadHandle,
  ThreadKey,
  ThreadMetadata,
} from "./thread-entry";

export class Agent {
  readonly #modelOptions: AgentModelOptions;
  readonly #threads = new Map<string, AgentThreadEntry>();
  readonly #sessionNamespace: string;
  readonly #store: SessionStore;
  readonly #host: AgentHost;
  readonly #plugins: readonly AgentPlugin[];
  readonly host: AgentHost;
  readonly namespace?: string;
  constructor(options: AgentOptions) {
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

  /**
   * Whether this agent's host can resume durable runs through `resume()`.
   *
   * `false` when the host is a `SessionHost`-only object (for example
   * `{ kind: "session", sessionStore }`). In that case the in-memory
   * `ExecutionHost` is not wired
   * up, so `resume(runId)` always returns `null` instead of throwing.
   */
  get supportsResume(): boolean {
    return executionHost(this.#host) !== undefined;
  }

  send(input: AgentInput): Promise<AgentRun> {
    return this.thread("default").send(input);
  }

  /**
   * Resume a durable run by id. Returns the resumed `AgentRun`, or `null` when
   * the host does not support durable resume (`supportsResume === false`), the
   * run id is unknown to this namespace, or a duplicate queue/alarm delivery
   * already claimed it. This never throws for a missing host; check
   * `supportsResume` first when you need to distinguish unsupported from
   * not-found.
   */
  async resume(runId: string): Promise<AgentRun | null> {
    const host = executionHost(this.#host);
    if (!host) {
      return null;
    }

    return await resumeAgentRun({
      host,
      ownerNamespace: this.#sessionNamespace,
      resumeNotification: (notification) =>
        this.#resumeNotification(notification),
      runId,
    });
  }

  thread(thread: ThreadKey): ThreadHandle {
    return this.#threadEntry(threadSessionKey(thread)).publicHandle;
  }

  #threadEntry(key: string): AgentThreadEntry {
    const existing = this.#threads.get(key);
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
    const publicHandle: ThreadHandle = {
      delete: async () => {
        session.kill();
        this.#evictThreadHandle(key);
        await session.delete();
      },
      dispose: () => {
        session.kill();
        this.#evictThreadHandle(key);
        return Promise.resolve();
      },
      interrupt: () => session.interrupt(),
      send: (input) => session.send(input),
      steer: (input) => session.steer(input),
    };
    const entry: AgentThreadEntry = {
      notify: (input, options) => session.notify(input, options),
      publicHandle,
    };
    this.#threads.set(key, entry);
    return entry;
  }

  #evictThreadHandle(key: string): void {
    this.#threads.delete(key);
  }

  #resumeNotification(notification: NotificationRecord): Promise<AgentRun> {
    return this.#threadEntry(notification.sessionKey).notify(
      notification.input,
      { observerEvents: notification.observerEvents }
    );
  }
}
