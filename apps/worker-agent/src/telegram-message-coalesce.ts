/**
 * Quiet-window message coalesce for Telegram.
 *
 * Resets the timer on every enqueue and flushes after silence. Designed for
 * Cloudflare Workers: enqueue returns immediately; long flush work is kept
 * alive only via `waitUntil` (never by blocking the webhook response).
 */

export interface CoalesceMessage {
  readonly attachments?: readonly unknown[];
  readonly author?: {
    readonly userId?: string;
  };
  readonly text?: string;
}

export interface CoalescePushItem<TMessage extends CoalesceMessage> {
  readonly message: TMessage;
  readonly subscribe?: boolean;
}

export interface CoalesceBatch<TMessage extends CoalesceMessage> {
  readonly messages: readonly TMessage[];
  readonly subscribe: boolean;
}

export type WaitUntil = (task: Promise<unknown>) => void;

export interface MessageCoalescerOptions<TMessage extends CoalesceMessage> {
  readonly onFlush: (
    key: string,
    batch: CoalesceBatch<TMessage>
  ) => Promise<void>;
  readonly quietMs: number;
  readonly schedule?: (
    callback: () => void,
    ms: number
  ) => { readonly clear: () => void };
}

interface PendingBatch<TMessage extends CoalesceMessage> {
  items: CoalescePushItem<TMessage>[];
  /** Settles when quiet-window flush (including agent turn) finishes. */
  lifetime: Promise<void>;
  resolveLifetime: () => void;
  timer: { clear: () => void } | undefined;
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

export function createMessageCoalescer<TMessage extends CoalesceMessage>(
  options: MessageCoalescerOptions<TMessage>
) {
  const pending = new Map<string, PendingBatch<TMessage>>();
  const schedule = options.schedule ?? defaultSchedule;

  const flush = async (key: string): Promise<void> => {
    const state = pending.get(key);
    if (!state) {
      return;
    }
    pending.delete(key);
    state.timer?.clear();
    state.timer = undefined;

    const batch: CoalesceBatch<TMessage> = {
      messages: state.items.map((item) => item.message),
      subscribe: state.items.some((item) => item.subscribe === true),
    };

    try {
      await options.onFlush(key, batch);
    } finally {
      state.resolveLifetime();
    }
  };

  return {
    /**
     * Enqueue a message and (re)arm the quiet timer.
     * Returns immediately — do not await agent work on the webhook path.
     * Pass `waitUntil` so the isolate stays alive through quiet wait + flush.
     */
    enqueue(
      key: string,
      item: CoalescePushItem<TMessage>,
      runtime: { readonly waitUntil?: WaitUntil } = {}
    ): void {
      let state = pending.get(key);
      if (!state) {
        let resolveLifetime = () => {
          return;
        };
        const lifetime = new Promise<void>((resolve) => {
          resolveLifetime = resolve;
        });
        state = {
          items: [],
          lifetime,
          resolveLifetime,
          timer: undefined,
        };
        pending.set(key, state);
      }

      state.items.push(item);
      state.timer?.clear();
      state.timer = schedule(() => {
        flush(key).catch(() => {
          // onFlush errors are handled inside reply path; lifetime still ends.
        });
      }, options.quietMs);

      // Keep isolate alive through quiet wait + agent turn without blocking
      // the webhook response (avoids Workers "hung request" / cross-context cancel).
      runtime.waitUntil?.(state.lifetime);
    },

    /** Test helper: pending batch size for a key. */
    pendingCount(key: string): number {
      return pending.get(key)?.items.length ?? 0;
    },

    /** Test helper: await current batch lifetime (flush done). */
    lifetime(key: string): Promise<void> | undefined {
      return pending.get(key)?.lifetime;
    },
  };
}
