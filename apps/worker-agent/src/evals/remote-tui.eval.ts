import type { AgentEvent } from "@minpeter/pss-runtime";
import type {
  AgentTurnLike,
  EvalThreadLike,
} from "@minpeter/pss-runtime/evals";
import { defineEval } from "@minpeter/pss-runtime/evals";
import { z } from "zod";

import type { WorkerAgentDeliveryResponse } from "../agent/agent-do-delivery";
import { createRemoteTuiDeliveryClient } from "../tui/tui-remote";
import { loadWorkerAgentEvalEnv } from "./eval-env";

const RemoteEvalEnvSchema = z.looseObject({
  WORKER_AGENT_TUI_CHANNEL_ID: z.string().trim().min(1).optional(),
  WORKER_AGENT_TUI_ENDPOINT: z.url().trim(),
  WORKER_AGENT_TUI_TOKEN: z.string().trim().min(1).optional(),
});
const NON_EMPTY_REPLY_PATTERN = /\S/u;

defineEval(
  "worker-agent-remote-tui",
  {
    tags: ["worker-agent", "remote"],
    thread: () => remoteTuiThread(),
  },
  (it) => {
    it("delivers one turn through the remote TUI endpoint", async (t) => {
      await t.run("eval smoke: 답장은 한 문장으로 remote eval ok 라고 말해줘.");

      t.completed();
      t.didNotFail();
      t.messageIncludes(NON_EMPTY_REPLY_PATTERN);
    });
  }
);

function remoteTuiThread(): EvalThreadLike {
  loadWorkerAgentEvalEnv();
  const env = RemoteEvalEnvSchema.parse(process.env);
  const client = createRemoteTuiDeliveryClient({
    channel: {
      id: env.WORKER_AGENT_TUI_CHANNEL_ID ?? "eval",
      kind: "tui",
    },
    endpoint: env.WORKER_AGENT_TUI_ENDPOINT,
    ...(env.WORKER_AGENT_TUI_TOKEN
      ? { token: env.WORKER_AGENT_TUI_TOKEN }
      : {}),
  });

  return {
    send: async (input) => remoteTurn(await client.deliver(input)),
  };
}

function remoteTurn(delivery: WorkerAgentDeliveryResponse): AgentTurnLike {
  return {
    events: () => remoteEvents(delivery),
  };
}

function remoteEvents(
  delivery: WorkerAgentDeliveryResponse
): AsyncIterable<AgentEvent> {
  const events: AgentEvent[] = [{ type: "turn-start" }];
  if (delivery.delivered) {
    for (const message of delivery.messages ?? []) {
      events.push({ text: message.text, type: "assistant-output" });
    }
    events.push({ type: "turn-end" });
  } else {
    events.push({ message: delivery.error, type: "turn-error" });
  }

  return {
    [Symbol.asyncIterator]: () => {
      const iterator = events[Symbol.iterator]();
      return {
        next: () => Promise.resolve(iterator.next()),
      };
    },
  };
}
