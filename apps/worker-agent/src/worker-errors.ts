import { defineErrorCatalog } from "evlog";

/**
 * Boundary failures only — user-facing Telegram replies stay app-owned.
 * Errors are for structured logs / wide events (code, why, fix).
 */
export const workerErrors = defineErrorCatalog("worker-agent", {
  ATTACHMENT_FETCH_FAILED: {
    message: "Failed to fetch Telegram image attachment",
    status: 502,
    why: "Telegram file download or decode failed before the agent turn",
    fix: "Retry the message or send a smaller image",
  },
  INVALID_TURN_PAYLOAD: {
    message: "text or attachments and channel required",
    status: 400,
    why: "Durable Object turn body failed validation",
    fix: "Send non-empty text and/or image attachments with a valid channel",
  },
  MISSING_SEND_MESSAGE: {
    message: "Agent did not deliver a send_message result",
    status: 502,
    why: "Primary turn and recovery both finished without a successful send_message tool result",
    fix: "Inspect model tool-calling and worker-agent instructions for send_message",
  },
  SESSION_INDEX_UPSERT_FAILED: {
    message: "Session index upsert failed",
    status: 500,
    why: "Post-turn session index write failed; user delivery may still have succeeded",
    fix: "Check Durable Object SQL session index storage and internal upsert route",
  },
  TELEGRAM_HANDLER_FAILED: {
    message: "Telegram message handling failed",
    status: 500,
    why: "Unhandled error while processing a Telegram webhook message",
    fix: "Inspect worker-agent turn and telegram handler logs for the correlationId",
  },
});
