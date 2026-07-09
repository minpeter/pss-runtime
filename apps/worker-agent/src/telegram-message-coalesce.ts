/**
 * Layer 1 — Telegram ingress fragment reassembly
 * (`TELEGRAM_INGRESS_LAYER` in message-path-layers.ts).
 *
 * Quiet-window coalesce for the Telegram/chat-sdk path only.
 *
 * Why this exists:
 * - Telegram + chat-sdk often deliver one user-facing "send" as several
 *   webhook updates (e.g. text, then a photo). Without reassembly the agent
 *   would see multiple user messages for a single human action.
 * - The quiet window resets on every enqueue so a late photo still joins the
 *   same forward batch (chat-sdk's own burst wait only runs once).
 *
 * What this is not:
 * - Not agent turn queueing.
 * - Not idle→send / running→steer policy (that is Layer 2 on the DO).
 *
 * Workers / waitUntil:
 * - Each enqueue registers **its own** work promise via `waitUntil`, created
 *   in that request's context: quiet delay → maybe flush.
 * - A generation counter supersedes older quiet waits without resolving a
 *   Promise that was created in another request (avoids cross-request
 *   promise resolution warnings / hung continuations).
 * - Concurrent flushes are allowed so a later batch can mid-turn steer.
 */

export interface CoalesceMessage {
  readonly attachments?: readonly unknown[];
  readonly author?: {
    readonly userId?: string;
  };
  readonly text?: string;
}

export interface CoalescePushItem<TMessage extends CoalesceMessage> {
  readonly correlationId?: string;
  readonly message: TMessage;
  readonly subscribe?: boolean;
}

export interface CoalesceBatch<TMessage extends CoalesceMessage> {
  readonly correlationId?: string;
  readonly messages: readonly TMessage[];
  readonly subscribe: boolean;
}

export type WaitUntil = (task: Promise<unknown>) => void;

export interface MessageCoalescerOptions<TMessage extends CoalesceMessage> {
  /** Delay helper for tests (fake timers). Defaults to setTimeout. */
  readonly delay?: (ms: number) => Promise<void>;
  readonly onFlush: (
    key: string,
    batch: CoalesceBatch<TMessage>
  ) => Promise<void>;
  /** Called when flush fails (after onFlush throws). */
  readonly onFlushError?: (
    key: string,
    error: unknown,
    batch: CoalesceBatch<TMessage>
  ) => void;
  readonly quietMs: number;
}

interface CollectingBatch<TMessage extends CoalesceMessage> {
  correlationId: string | undefined;
  items: CoalescePushItem<TMessage>[];
}

interface ChannelState<TMessage extends CoalesceMessage> {
  collecting: CollectingBatch<TMessage> | undefined;
  /**
   * Bumped on every enqueue. Quiet work only flushes when it still owns the
   * latest generation (created in the same request that called waitUntil).
   */
  generation: number;
  /** Number of onFlush calls currently in flight for this channel. */
  inFlight: number;
}

export class MissingWaitUntilError extends Error {
  constructor(message = "waitUntil is required for telegram message coalesce") {
    super(message);
    this.name = "MissingWaitUntilError";
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toBatch<TMessage extends CoalesceMessage>(
  items: readonly CoalescePushItem<TMessage>[],
  correlationId: string | undefined
): CoalesceBatch<TMessage> {
  return {
    ...(correlationId ? { correlationId } : {}),
    messages: items.map((item) => item.message),
    subscribe: items.some((item) => item.subscribe === true),
  };
}

/**
 * Create a Layer 1 ingress coalescer.
 * Flush callbacks should only forward to the agent (Layer 2); they must not
 * implement send/steer policy themselves.
 */
export function createMessageCoalescer<TMessage extends CoalesceMessage>(
  options: MessageCoalescerOptions<TMessage>
) {
  const channels = new Map<string, ChannelState<TMessage>>();
  const delay = options.delay ?? defaultDelay;

  const ensureChannel = (key: string): ChannelState<TMessage> => {
    let state = channels.get(key);
    if (!state) {
      state = {
        collecting: undefined,
        generation: 0,
        inFlight: 0,
      };
      channels.set(key, state);
    }
    return state;
  };

  const maybeDeleteChannel = (
    key: string,
    state: ChannelState<TMessage>
  ): void => {
    if (state.inFlight > 0 || state.collecting) {
      return;
    }
    channels.delete(key);
  };

  const flushCollecting = async (key: string): Promise<void> => {
    const state = channels.get(key);
    if (!state?.collecting) {
      return;
    }

    const collecting = state.collecting;
    state.collecting = undefined;

    if (collecting.items.length === 0) {
      maybeDeleteChannel(key, state);
      return;
    }

    const batch = toBatch(collecting.items, collecting.correlationId);
    state.inFlight += 1;
    try {
      await options.onFlush(key, batch);
    } catch (error) {
      options.onFlushError?.(key, error, batch);
    } finally {
      state.inFlight -= 1;
      maybeDeleteChannel(key, state);
    }
  };

  /**
   * Work owned by the enqueueing request: wait quietMs, then flush only if
   * this generation is still current. Registered via that request's waitUntil.
   */
  const runQuietThenMaybeFlush = async (
    key: string,
    generation: number
  ): Promise<void> => {
    await delay(options.quietMs);
    const state = channels.get(key);
    if (!state || state.generation !== generation) {
      // Superseded by a later fragment in another request — do not flush here.
      return;
    }
    await flushCollecting(key);
  };

  return {
    /**
     * Enqueue a Telegram fragment. Returns immediately.
     * `waitUntil` must register the **returned work promise from this call**
     * (same request context) so quiet + flush stay alive without sharing a
     * deferred Promise across requests.
     */
    enqueue(
      key: string,
      item: CoalescePushItem<TMessage>,
      runtime: { readonly waitUntil?: WaitUntil } = {}
    ): void {
      if (!runtime.waitUntil) {
        throw new MissingWaitUntilError();
      }

      const state = ensureChannel(key);
      const correlation = item.correlationId?.trim();

      if (!state.collecting) {
        state.collecting = {
          correlationId: correlation,
          items: [],
        };
      } else if (!state.collecting.correlationId && correlation) {
        state.collecting.correlationId = correlation;
      }

      state.collecting.items.push(item);
      state.generation += 1;
      const generation = state.generation;

      // Create work in *this* request context; never resolve foreign promises.
      runtime.waitUntil(runQuietThenMaybeFlush(key, generation));
    },

    /** Test helper: messages waiting in the quiet window. */
    pendingCount(key: string): number {
      return channels.get(key)?.collecting?.items.length ?? 0;
    },

    /** Test helper: first correlation id of the collecting batch. */
    correlationId(key: string): string | undefined {
      return channels.get(key)?.collecting?.correlationId;
    },

    /** Test helper: number of in-flight flushes. */
    inFlightCount(key: string): number {
      return channels.get(key)?.inFlight ?? 0;
    },

    /** Test helper: current quiet generation for a channel. */
    generation(key: string): number {
      return channels.get(key)?.generation ?? 0;
    },
  };
}
