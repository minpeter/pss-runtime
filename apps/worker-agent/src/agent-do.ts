import { DurableObject } from "cloudflare:workers";
import type {
  Agent,
  AgentEvent,
  AgentTurn,
  ThreadInspection,
} from "@minpeter/pss-runtime";
import {
  type CloudflareAgentContext,
  createCloudflareAgentContext,
} from "@minpeter/pss-runtime/cloudflare";
import { z } from "zod";

import { collectTurnDelivery, createConfiguredAgent } from "./agent";
import { type ChannelAddress, ChannelAddressSchema } from "./channel";
import type { Env } from "./env";
import { createTelegramMessageSink } from "./telegram-sink";
import type { WorkerAgentSendMessageToolOptions } from "./tools";
import { createTuiResponseMessageSink } from "./tui-response-sink";

const SESSION_KEY = "default";
const MISSING_SEND_MESSAGE_ERROR = "missing_send_message";
export const TOOL_ONLY_DELIVERY_RECOVERY_PROMPT =
  "Your previous user-triggered turn ended without a successful send_message tool result. The user still has not received your answer. Using the immediately preceding user request and any assistant text you already drafted, call send_message now. Do not answer in assistant text only.";
const AgentRequestSchema = z
  .object({
    channel: ChannelAddressSchema,
    text: z.string(),
  })
  .strict();
const AgentInspectRequestSchema = z
  .object({ inspect: z.literal(true) })
  .strict();

interface AgentRequestPayload {
  readonly channel: ChannelAddress;
  readonly text: string;
}

export interface WorkerAgentThreadSender {
  send(input: string): Promise<AgentTurn>;
}

export interface DeliverToolOnlyTurnOptions {
  readonly onAssistantOutput?: (text: string) => void;
  readonly onEvent?: (event: AgentEvent) => void;
}

export type WorkerAgentDeliveryResponse =
  | {
      readonly delivered: true;
      readonly messages?: readonly WorkerAgentDeliveredMessage[];
    }
  | {
      readonly delivered: false;
      readonly error: typeof MISSING_SEND_MESSAGE_ERROR;
    };

export interface WorkerAgentDeliveredMessage {
  readonly messageId: string;
  readonly text: string;
  readonly threadId: string;
}

interface SendMessageToolSetup {
  readonly messages: () => readonly WorkerAgentDeliveredMessage[];
  readonly options: WorkerAgentSendMessageToolOptions;
}

interface DurableThreadInspector {
  thread(key: string): {
    inspect(): Promise<ThreadInspection>;
  };
}

interface JsonRequestBody {
  json(): Promise<unknown>;
}

export class AgentDurableObject extends DurableObject<Env> {
  readonly #context: CloudflareAgentContext<Agent>;
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#env = env;
    this.#context = createCloudflareAgentContext({
      createAgent: ({ env: agentEnv, host }) =>
        createConfiguredAgent(agentEnv, host, {
          sendMessage: createSendMessageToolOptions(agentEnv, () => undefined),
        }),
      env,
      storage: state.storage,
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (await isAgentInspectRequest(request.clone())) {
      const agent = createConfiguredAgent(this.#env, this.#context.host());
      return Response.json(await inspectDurableThread(agent));
    }

    const payload = await parseAgentRequest(request);
    if (!payload) {
      return new Response("text and channel required", { status: 400 });
    }

    const sendMessage = createRequestSendMessageToolSetup(
      this.#env,
      payload.channel
    );
    const agent = createConfiguredAgent(this.#env, this.#context.host(), {
      sendMessage: sendMessage.options,
    });
    const delivery = await deliverToolOnlyTurn(
      agent.thread(SESSION_KEY),
      payload.text
    );

    return Response.json(
      withCapturedMessages(delivery, sendMessage.messages())
    );
  }

  async alarm(): Promise<void> {
    await this.#context.drainAlarm();
  }
}

export function inspectDurableThread(
  agent: DurableThreadInspector
): Promise<ThreadInspection> {
  return agent.thread(SESSION_KEY).inspect();
}

function createSendMessageToolOptions(
  env: Env,
  channel: () => ChannelAddress | undefined
): WorkerAgentSendMessageToolOptions {
  const userName = env.TELEGRAM_BOT_USERNAME?.trim();
  return {
    channel,
    sink: createTelegramMessageSink({
      botToken: env.TELEGRAM_BOT_TOKEN,
      ...(userName ? { userName } : {}),
    }),
  };
}

function createRequestSendMessageToolSetup(
  env: Env,
  channel: ChannelAddress
): SendMessageToolSetup {
  switch (channel.kind) {
    case "telegram":
      return {
        messages: () => [],
        options: createSendMessageToolOptions(env, () => channel),
      };
    case "tui": {
      const responseSink = createTuiResponseMessageSink();
      return {
        messages: responseSink.messages,
        options: {
          channel: () => channel,
          sink: responseSink.sink,
        },
      };
    }
    default:
      return assertNever(channel.kind);
  }
}

function withCapturedMessages(
  delivery: WorkerAgentDeliveryResponse,
  messages: readonly WorkerAgentDeliveredMessage[]
): WorkerAgentDeliveryResponse {
  if (!delivery.delivered || messages.length === 0) {
    return delivery;
  }

  return {
    delivered: true,
    messages,
  };
}

export async function deliverToolOnlyTurn(
  thread: WorkerAgentThreadSender,
  text: string,
  options: DeliverToolOnlyTurnOptions = {}
): Promise<WorkerAgentDeliveryResponse> {
  const collectOptions = {
    ...(options.onAssistantOutput
      ? { onAssistantOutput: options.onAssistantOutput }
      : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };
  const firstRun = await thread.send(text);
  const firstDelivery = await collectTurnDelivery(firstRun, collectOptions);
  if (firstDelivery.deliveredByTool) {
    return { delivered: true };
  }

  const recoveryRun = await thread.send(TOOL_ONLY_DELIVERY_RECOVERY_PROMPT);
  const recoveryDelivery = await collectTurnDelivery(
    recoveryRun,
    collectOptions
  );
  if (recoveryDelivery.deliveredByTool) {
    return { delivered: true };
  }

  return {
    delivered: false,
    error: MISSING_SEND_MESSAGE_ERROR,
  };
}

export async function parseAgentRequest(
  request: Request
): Promise<AgentRequestPayload | undefined> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    if (error instanceof Error) {
      return;
    }
    throw error;
  }

  const result = AgentRequestSchema.safeParse(payload);
  if (!result.success) {
    return;
  }

  const channelId = result.data.channel.id.trim();
  const text = result.data.text.trim();
  return channelId && text
    ? { channel: { id: channelId, kind: result.data.channel.kind }, text }
    : undefined;
}

async function isAgentInspectRequest(
  request: JsonRequestBody
): Promise<boolean> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    if (error instanceof Error) {
      return false;
    }
    throw error;
  }

  return AgentInspectRequestSchema.safeParse(payload).success;
}

function assertNever(value: never): never {
  throw new AgentDurableObjectInvariantError(
    `Unexpected channel variant: ${String(value)}`
  );
}

class AgentDurableObjectInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDurableObjectInvariantError";
  }
}
