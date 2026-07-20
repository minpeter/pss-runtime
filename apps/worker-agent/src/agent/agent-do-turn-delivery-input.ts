import type { AgentInput } from "@minpeter/pss-runtime";

import { workerErrors } from "../worker-errors";
import type { createTurnLogger } from "../worker-log";
import type { AgentRequestPayload } from "./agent-do-request";
import {
  agentInputFromRequest,
  InvalidAttachmentBase64Error,
} from "./agent-input";

export function parseTurnAgentInput(
  payload: AgentRequestPayload,
  log: ReturnType<typeof createTurnLogger>
): AgentInput | Response {
  try {
    return agentInputFromRequest(payload);
  } catch (error) {
    if (error instanceof InvalidAttachmentBase64Error) {
      const invalid = workerErrors.INVALID_TURN_PAYLOAD();
      log.error(invalid);
      log.set({ outcome: "invalid_attachment_base64" });
      log.emit({ status: 400 });
      return new Response(invalid.message, { status: 400 });
    }
    throw error;
  }
}
