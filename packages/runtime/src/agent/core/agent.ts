import type { AgentHost, NotificationRecord } from "../../execution/host/types";
import { createInMemoryHost } from "../../platform/memory";
import { type AgentInput, AgentThread } from "../../thread/handle/thread";
import type { AgentPlugin } from "../../thread/plugins/pipeline";
import type { AgentTurn } from "../../thread/protocol/turn";
import type { ThreadStore } from "../../thread/store/types";
import { stableAgentNamespace } from "../identity/namespace";
import { resumeAgentTurn } from "../resume/resume";
import { threadStoreForHost } from "./host-thread-store";
import {
  type AgentAutoCompactionOptions,
  type AgentModelOptions,
  type AgentOptions,
  assertAgentOptions,
  normalizeAgentAutoCompactionOptions,
} from "./options";
import {
  type AgentThreadEntry,
  type ThreadHandle,
  type ThreadKey,
  threadStoreKey,
} from "./thread-entry";

export type { AgentHost } from "../../execution/host/types";
export type { ThreadCompactionInput } from "../../thread/handle/thread";
export type { AgentAutoCompactionOptions, AgentOptions } from "./options";
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
  readonly #notificationOverlays?: AgentOptions["notificationOverlays"];
  readonly #autoCompaction?: AgentAutoCompactionOptions;
  readonly host: AgentHost;
  readonly namespace?: string;
  constructor(options: AgentOptions) {
    assertAgentOptions(options);

    const providedHost = options.host;
    this.namespace = options.namespace;
    this.#ownerNamespace = stableAgentNamespace({
      namespace: options.namespace,
    });
    this.#host = providedHost ?? createInMemoryHost();
    this.host = this.#host;
    this.#store = threadStoreForHost(this.#host);
    this.#plugins = options.plugins ?? [];
    this.#notificationOverlays = options.notificationOverlays;
    this.#autoCompaction = normalizeAgentAutoCompactionOptions(
      options.autoCompaction
    );
    this.#modelOptions = {
      attachmentStore:
        providedHost?.attachmentStore ??
        options.attachmentStore ??
        this.#host.attachmentStore,
      contextGate: this.#autoCompaction?.contextGate,
      instructions: options.instructions,
      model: options.model,
      toolChoice: options.toolChoice,
      tools: options.tools,
    };
  }

  /**
   * Whether this agent's host can resume durable runs through `resume()`.
   * Always true for the single AgentHost contract.
   */
  get supportsResume(): boolean {
    return true;
  }

  send(input: AgentInput): Promise<AgentTurn> {
    return this.thread("default").send(input);
  }

  overlay(input: AgentInput): ThreadHandle {
    return this.thread("default").overlay(input);
  }

  /**
   * Resume a durable run by id. Returns the resumed `AgentTurn`, or `null` when
   * the host does not support durable resume (`supportsResume === false`), the
   * run id is unknown to this namespace, or a duplicate queue/alarm delivery
   * already claimed it. This never throws for a missing host; check
   * `supportsResume` first when you need to distinguish unsupported from
   * not-found.
   */
  async resume(runId: string): Promise<AgentTurn | null> {
    return await resumeAgentTurn({
      host: this.#host,
      ownerNamespace: this.#ownerNamespace,
      resumeNotification: (notification) =>
        this.#resumeNotification(notification),
      runId,
    });
  }

  thread(thread: ThreadKey): ThreadHandle {
    return this.#threadEntry(threadStoreKey(thread)).publicHandle;
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
        autoCompaction: this.#autoCompaction,
        executionHost: this.#host,
      }
    );
    const publicHandle: ThreadHandle = {
      compact: (input) => thread.compact(input),
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
      events: (options) => thread.events(options),
      interrupt: () => thread.interrupt(),
      overlay: (input) => {
        thread.overlay(input);
        return publicHandle;
      },
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

  #resumeNotification(notification: NotificationRecord): Promise<AgentTurn> {
    return this.#threadEntry(notification.threadKey).notify(
      notification.input,
      {
        observerEvents: notification.observerEvents,
        overlays: [
          ...(notification.overlays ?? []),
          ...(this.#notificationOverlays ?? []),
        ],
      }
    );
  }
}
