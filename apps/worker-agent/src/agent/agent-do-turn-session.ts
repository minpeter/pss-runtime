/**
 * Layer 2 — Agent turn admission
 * (`AGENT_TURN_ADMISSION_LAYER` in message-path-layers.ts).
 *
 * Per-thread admission for worker-agent Durable Objects.
 *
 * Every user message that reaches the DO is delivered immediately:
 * - idle    → `thread.send`  (new tool-only turn; may include recovery send)
 * - running → `thread.steer` (same turn, mid-turn injection at step boundaries)
 *
 * What this is not:
 * - Not Telegram fragment reassembly (Layer 1 quiet window in telegram-*).
 * - No extra debounce before send/steer; if a message arrives here, admit it.
 *
 * Admission is serialized so two concurrent HTTP requests cannot both start
 * sends. The active send itself is not held on the admit chain, so mid-turn
 * steers can be accepted while the first turn is still draining.
 */

import type { AgentInput, AgentTurn } from "@minpeter/pss-runtime";

import {
  type DeliverToolOnlyTurnOptions,
  deliverToolOnlyTurn,
  type WorkerAgentDeliveryResponse,
} from "./agent-do-delivery";

type TurnDeliveryMode = "send" | "steer";

type TurnSessionDelivery =
  | {
      readonly delivered: true;
      readonly mode: TurnDeliveryMode;
    }
  | {
      readonly delivered: false;
      readonly error: Extract<
        WorkerAgentDeliveryResponse,
        { delivered: false }
      >["error"];
      readonly mode: "send";
    };

export interface TurnSessionThread {
  send(input: AgentInput): Promise<AgentTurn>;
  steer(input: AgentInput): Promise<AgentTurn>;
}

interface TurnSessionDeliverOptions extends DeliverToolOnlyTurnOptions {
  /** Called once when this delivery starts a new send turn (not on steer). */
  readonly onSendStarted?: () => void;
}

export interface TurnSession {
  deliver(
    input: AgentInput,
    options?: TurnSessionDeliverOptions
  ): Promise<TurnSessionDelivery>;
  isActive(): boolean;
}

export function createTurnSession(thread: TurnSessionThread): TurnSession {
  let admit: Promise<void> = Promise.resolve();
  let active: Promise<unknown> | undefined;

  return {
    deliver(input, options = {}) {
      return new Promise((resolve, reject) => {
        const runAdmit = (): Promise<void> => {
          // Layer 2 policy: running → steer, idle → send.
          if (active) {
            return thread.steer(input).then(
              () => {
                resolve({ delivered: true, mode: "steer" });
              },
              (error: unknown) => {
                reject(error);
              }
            );
          }

          options.onSendStarted?.();
          const work = deliverToolOnlyTurn(thread, input, options).then(
            (delivery): TurnSessionDelivery => {
              if (delivery.delivered) {
                return { delivered: true, mode: "send" };
              }
              return {
                delivered: false,
                error: delivery.error,
                mode: "send",
              };
            }
          );
          const tracked = work.finally(() => {
            if (active === tracked) {
              active = undefined;
            }
          });
          active = tracked;
          tracked.then(resolve, reject);
          return Promise.resolve();
        };

        admit = admit.then(runAdmit, runAdmit);
      });
    },

    isActive() {
      return active !== undefined;
    },
  };
}
