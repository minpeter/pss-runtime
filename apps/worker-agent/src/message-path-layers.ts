/**
 * Inbound message path — two layers. Do not conflate them.
 *
 * ```
 * Telegram webhooks / chat-sdk handlers
 *                 │
 *                 ▼
 * ┌───────────────────────────────────────────────────────────────┐
 * │ Layer 1 — Telegram ingress fragment reassembly                │
 * │ files: telegram-message-coalesce.ts, telegram.ts (coalescer)  │
 * │                                                               │
 * │ Purpose: chat-sdk / Telegram may split one user-facing send   │
 * │ into multiple webhook updates (text then photo, burst text).  │
 * │ A short quiet window rebuilds one forward batch before the    │
 * │ agent sees it.                                                │
 * │                                                               │
 * │ This is a Telegram/chat-sdk ingress patch only.               │
 * │ It is NOT agent turn queueing and NOT mid-turn steer policy.  │
 * └───────────────────────────────────────────────────────────────┘
 *                 │
 *                 │  each flush = one user message (possibly multi-part)
 *                 ▼
 * ┌───────────────────────────────────────────────────────────────┐
 * │ Layer 2 — Agent turn admission                                │
 * │ files: agent-do-turn-session.ts, agent-do.ts (DO /turn)       │
 * │                                                               │
 * │ Purpose: deliver every user message immediately to the agent. │
 * │   idle    → thread.send  (new turn)                           │
 * │   running → thread.steer (same turn, mid-turn injection)      │
 * │                                                               │
 * │ No quiet-window delay lives here. Steer stacking is runtime   │
 * │ active-turn policy, independent of Telegram fragment timing.  │
 * └───────────────────────────────────────────────────────────────┘
 * ```
 */

/** Layer 1 id — Telegram/chat-sdk fragment reassembly before agent delivery. */
export const TELEGRAM_INGRESS_LAYER =
  "telegram-ingress-fragment-reassembly" as const;

/** Layer 2 id — DO admission: idle send / running steer. */
export const AGENT_TURN_ADMISSION_LAYER = "agent-turn-admission" as const;

export type MessagePathLayer =
  | typeof TELEGRAM_INGRESS_LAYER
  | typeof AGENT_TURN_ADMISSION_LAYER;
