import { executionHost } from "../../execution/host/host";
import type { AgentHost, NotificationRecord } from "../../execution/host/types";
import { createInMemoryExecutionHost } from "../../execution/memory";
import { type AgentInput, AgentThread } from "../../thread/handle/thread";
import type { AgentPlugin } from "../../thread/plugins/pipeline";
import type { AgentRun } from "../../thread/protocol/run";
import type { ThreadStore } from "../../thread/store/types";
import { stableAgentNamespace } from "../identity/namespace";
import { resumeAgentRun } from "../resume/resume";
import { threadStoreForHost } from "./host-thread-store";
import {
  type AgentModelOptions,
  type AgentOptions,
  assertAgentOptions,
} from "./options";
import {
  type AgentThreadEntry,
  normalizeThreadKey,
  type ThreadHandle,
  type ThreadKey,
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
  readonly #ownerNamespace: string;
  readonly #store: ThreadStore;
  readonly #host: AgentHost;
  readonly #plugins: readonly AgentPlugin[];
  readonly host: AgentHost;
  readonly namespace?: string;
  constructor(options: AgentOptions) {
    assertAgentOptions(options);

    this.namespace = options.namespace;
    this.#ownerNamespace = stableAgentNamespace({
      namespace: options.namespace,
    });
    this.#host = options.host ?? createInMemoryExecutionHost();
    this.host = this.#host;
    this.#store = threadStoreForHost(this.#host);
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
   * `false` when the host is a `ThreadHost`-only object (for example
   * `{ kind: "thread", threadStore }`). In that case the in-memory `ExecutionHost` is not wired
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
      ownerNamespace: this.#ownerNamespace,
      resumeNotification: (notification) =>
        this.#resumeNotification(notification),
      runId,
    });
  }

  thread(thread: ThreadKey): ThreadHandle {
    return this.#threadEntry(normalizeThreadKey(thread)).publicHandle;
  }

  #threadEntry(key: string): AgentThreadEntry {
    const existing = this.#threads.get(key);
    if (existing) {
      return existing;
    }

    let thread: AgentThread | undefined;
    thread = new AgentThread(
      this.#modelOptions,
      { key, store: this.#store },
      this.#plugins,
      {
        executionHost: executionHost(this.#host),
      }
    );
    const publicHandle: ThreadHandle = {
      delete: async () => {
        thread.kill();
        this.#evictThreadHandle(key);
        await thread.delete();
      },
      dispose: () => {
        thread.kill();
        this.#evictThreadHandle(key);
        return Promise.resolve();
      },
      interrupt: () => thread.interrupt(),
      send: (input) => thread.send(input),
      steer: (input) => thread.steer(input),
    };
    const entry: AgentThreadEntry = {
      notify: (input, options) => thread.notify(input, options),
      publicHandle,
    };
    this.#threads.set(key, entry);
    return entry;
  }

  #evictThreadHandle(key: string): void {
    this.#threads.delete(key);
  }

  #resumeNotification(notification: NotificationRecord): Promise<AgentRun> {
    return this.#threadEntry(notification.threadKey).notify(
      notification.input,
      { observerEvents: notification.observerEvents }
    );
  }
}
