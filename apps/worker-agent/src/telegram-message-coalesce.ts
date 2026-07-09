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
 * - The quiet timer resets on every enqueue so a late photo still joins the
 *   same forward batch (chat-sdk's own burst wait only runs once).
 *
 * What this is not:
 * - Not agent turn queueing.
 * - Not idle→send / running→steer policy (that is Layer 2 on the DO).
 *
 * After flush, one reassembled batch is handed to the agent immediately.
 * Concurrent flushes are allowed so a later batch can mid-turn steer while
 * an earlier agent turn is still running (Layer 2 decides send vs steer).
 *
 * waitUntil keeps the isolate alive through quiet wait + in-flight flushes.
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
  readonly onFlush: (
    key: string,
    batch: CoalesceBatch<TMessage>
  ) => Promise<void>;
  /** Called when flush fails (after onFlush throws). Lifetime still settles. */
  readonly onFlushError?: (
    key: string,
    error: unknown,
    batch: CoalesceBatch<TMessage>
  ) => void;
  readonly quietMs: number;
  readonly schedule?: (
    callback: () => void,
    ms: number
  ) => { readonly clear: () => void };
}

interface CollectingBatch<TMessage extends CoalesceMessage> {
  correlationId: string | undefined;
  items: CoalescePushItem<TMessage>[];
  timer: { clear: () => void } | undefined;
}

interface ChannelState<TMessage extends CoalesceMessage> {
  collecting: CollectingBatch<TMessage> | undefined;
  /** Number of onFlush calls currently in flight for this channel. */
  inFlight: number;
  /**
   * Lifetime of the current chain (collect quiet + flush). Extended while
   * work remains so waitUntil keeps the isolate alive.
   */
  lifetime: Promise<void> | undefined;
  resolveLifetime: (() => void) | undefined;
}

export class MissingWaitUntilError extends Error {
  constructor(message = "waitUntil is required for telegram message coalesce") {
    super(message);
    this.name = "MissingWaitUntilError";
  }
}

function defaultSchedule(
  callback: () => void,
  ms: number
): { clear: () => void } {
  const handle = setTimeout(callback, ms);
  return {
    clear: () => {
      clearTimeout(handle);
    },
  };
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
  const schedule = options.schedule ?? defaultSchedule;

  const ensureChannel = (key: string): ChannelState<TMessage> => {
    let state = channels.get(key);
    if (!state) {
      state = {
        collecting: undefined,
        inFlight: 0,
        lifetime: undefined,
        resolveLifetime: undefined,
      };
      channels.set(key, state);
    }
    return state;
  };

  const ensureLifetime = (
    state: ChannelState<TMessage>,
    waitUntil: WaitUntil
  ): void => {
    if (!state.lifetime) {
      let resolveLifetime = () => {
        return;
      };
      state.lifetime = new Promise<void>((resolve) => {
        resolveLifetime = resolve;
      });
      state.resolveLifetime = resolveLifetime;
    }
    waitUntil(state.lifetime);
  };

  const maybeEndLifetime = (
    key: string,
    state: ChannelState<TMessage>
  ): void => {
    if (state.inFlight > 0 || state.collecting) {
      return;
    }
    state.resolveLifetime?.();
    state.lifetime = undefined;
    state.resolveLifetime = undefined;
    channels.delete(key);
  };

  const flushCollecting = async (key: string): Promise<void> => {
    const state = channels.get(key);
    if (!state?.collecting) {
      return;
    }

    const collecting = state.collecting;
    collecting.timer?.clear();
    state.collecting = undefined;

    if (collecting.items.length === 0) {
      maybeEndLifetime(key, state);
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
      maybeEndLifetime(key, state);
    }
  };

  const armTimer = (key: string, state: ChannelState<TMessage>): void => {
    const collecting = state.collecting;
    if (!collecting) {
      return;
    }
    collecting.timer?.clear();
    collecting.timer = schedule(() => {
      flushCollecting(key).catch(() => {
        // onFlushError already invoked; lifetime settled in finally.
      });
    }, options.quietMs);
  };

  return {
    /**
     * Enqueue a Telegram fragment. Returns immediately.
     * `waitUntil` is required so the isolate stays alive through quiet wait + flush.
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
      ensureLifetime(state, runtime.waitUntil);

      const correlation = item.correlationId?.trim();

      if (!state.collecting) {
        state.collecting = {
          correlationId: correlation,
          items: [],
          timer: undefined,
        };
      } else if (!state.collecting.correlationId && correlation) {
        state.collecting.correlationId = correlation;
      }

      state.collecting.items.push(item);
      armTimer(key, state);
    },

    /** Test helper: messages waiting in the quiet window. */
    pendingCount(key: string): number {
      return channels.get(key)?.collecting?.items.length ?? 0;
    },

    /** Test helper: await current chain lifetime (all work done). */
    lifetime(key: string): Promise<void> | undefined {
      return channels.get(key)?.lifetime;
    },

    /** Test helper: first correlation id of the collecting batch. */
    correlationId(key: string): string | undefined {
      return channels.get(key)?.collecting?.correlationId;
    },

    /** Test helper: number of in-flight flushes. */
    inFlightCount(key: string): number {
      return channels.get(key)?.inFlight ?? 0;
    },
  };
}
