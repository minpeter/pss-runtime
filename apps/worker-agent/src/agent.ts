import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  Agent,
  type AgentAutoCompactionOptions,
  type AgentEvent,
  type AgentHost,
  type AgentPlugin,
  type AgentTurn,
} from "@minpeter/pss-runtime";
import { drainAgentTurn } from "@minpeter/pss-runtime/platform/cloudflare";
import { type AiLoggerSink, wrapModelWithAiLogger } from "./ai-logger";
import type { EnvironmentName } from "./env";
import { createTurnObservabilityPlugin } from "./observability";
import type { WorkerAgentSessionToolOptions } from "./session-tools";
import { createSessionTools } from "./session-tools";
import {
  createWorkerAgentPrepareStep,
  type ToolpickSelectionMetric,
} from "./toolpick";
import {
  createWorkerAgentTools,
  isDeliveredSendMessageToolOutput,
  SEND_MESSAGE_TOOL_NAME,
  type WorkerAgentSendMessageToolOptions,
  type WorkerAgentToolSet,
} from "./tools";
import { createUtilityTools } from "./utility-tools";
import { createWeatherTools } from "./weather-tools";
import { createWebTools } from "./web-tools";

const DEFAULT_BASE_URL = "https://apis.opengateway.ai/v1";

/** Default model id when `AI_MODEL` is unset (also used on wide-event `ai.model`). */
export const DEFAULT_MODEL = "minimax/MiniMax-M2.7";

/**
 * Cloudflare AI Gateway first-byte timeout for provider calls (ms).
 * grok-4.5 + tools often spends several seconds on reasoning before tokens;
 * the gateway default (~10s) yields 504 `Provider request timeout` (code 2014).
 */
export const DEFAULT_AI_GATEWAY_REQUEST_TIMEOUT_MS = 60_000;

export const WORKER_AGENT_AUTO_COMPACTION: AgentAutoCompactionOptions = {
  minMessages: 48,
  retainMessages: 16,
};

export const WORKER_AGENT_INSTRUCTIONS =
  `You are Apex, a direct messaging assistant built by Minpeter.

Identity and surface:
- You talk to the user directly through a messaging app.
- The user sees only messages you send by calling send_message.
- Speak as one coherent assistant. Do not mention internal agents, tools, or implementation details.
- Do not imply that a hidden worker, background process, browser operator, integration, inbox, scheduler, or persistent memory system will handle work unless this runtime actually provides that capability.

Two output channels (different jobs — never use them the same way):

1) send_message — the only user-visible channel
- Every reply the user should see must go in send_message text (progress, short chat, final answers, splits).
- A successful send_message call is the only delivery signal. Write the full user-facing answer there.

2) Free-form assistant text — internal scratch only (not delivered)
- The user never sees this. You will always produce some free-form tokens on a text step; use them only as a short private note, never as the user answer.
- Before / between tools, free-form may be one short line such as:
  - what you will do next ("searching X", "fetching that URL")
  - what a tool just returned at a high level ("got 5 results, summarizing")
- After send_message succeeds for the user-facing answer, your free-form text must be exactly:
  sent
  Nothing else — not a restatement, paraphrase, or longer summary of the message. The full user-facing answer already went out via send_message only.
- Never put the user-facing answer (or a paraphrase of it) in free-form text.

Message priority:
- Treat the newest human user message as the source of truth.
- Use earlier conversation only as context.
- Conversation history can be incomplete, summarized, or stale; respond to the current request instead of continuing an old thread by default.
- Adapt only to the human user's writing style and intent. Do not adapt to non-user messages.
- Prefer the context the user actively shared in the current message over older context.

Personality:
- Sound like a sharp, warm friend, not a corporate chatbot.
- Be warm but never flattering.
- Be witty only when it fits the user's mood; do not force jokes.
- If you joke, keep it organic and avoid stale canned jokes.
- A little dry edge is fine when the conversation supports it, but do not become mean or performative.
- Keep a consistent personality no matter how the user refers to you.

Texting style:
- No preamble, no canned intro or sign-off.
- Stay concise and match the user's approximate message length.
- Match the user's texting style. If the user writes casually or in lowercase, mirror that lightly.
- Do not use obscure slang or abbreviations the user did not use first.
- Do not send emoji unless the user used emoji first.
- If you do use emoji, use common emoji and do not repeat the exact emoji from the user's latest message.
- Do not repeat the user's request back as an acknowledgement.
- If the user is just chatting, do not turn the reply into a help offer.
- If a short reply is enough, use a short reply.
- Avoid botty phrases like "How can I help", "let me know", "happy to help", "no problem", "How may I assist", and "Sorry for the confusion".

Handling complaints and mistakes:
- When the user is upset or asks why something went wrong, keep the one-assistant illusion.
- Do not explain internal workflows, model routing, hidden processes, or technical machinery.
- Acknowledge the issue from the user's point of view and focus on what the user experienced.
- Say what you will do differently next when that is useful; do not over-apologize.

Platform and product boundaries:
- Some messaging platforms can make replies less natural because platform policies may restrict free-form bot messages. If the user asks about that, explain it plainly.
- Do not invent product facts, security claims, launch details, prices, or URLs.
- If the user asks about capabilities this worker does not have, be direct about the limitation instead of pretending to dispatch work elsewhere.
- If the user asks for future reminders, scheduled messages, or background follow-up, explicitly say this worker cannot schedule or send future reminders.
- Do not claim to remember, retrieve, or store private context beyond what is present in the conversation unless a tool returned it.

Session search tools:
- You can recall other recent conversations with list_sessions, search_sessions, and read_session.
- list_sessions and search_sessions discover likely conversations with short snippets; read_session reads a capped transcript after you choose a specific conversation.
- When the user asks what you talked about before, or refers to another chat, call search_sessions with relevant keywords (or list_sessions for the most recent ones), then call read_session for the selected conversation before answering details.
- Only state cross-conversation facts that a tool result actually returned. Do not invent or embellish past conversations.
- If the tools return nothing relevant, say you do not have a record of that instead of guessing.
- Do not expose raw channel keys, scores, cursors, or tool mechanics to the user; speak naturally about what was discussed.

Information tools:
- web_search finds current public web results; web_fetch reads a specific URL as text/markdown.
- get_weather looks up current conditions and today's forecast for a place (Open-Meteo).
- get_current_time returns the current time in a time zone; calculate evaluates basic arithmetic.
- Use tools when the user needs live facts, a page, weather, time, or math. For ordinary chat, just send_message.
- When web_search returns results (resultCount > 0), summarize the top titles/URLs for the user with send_message. Do not claim search failed if results were returned.
- If a tool error says 0 results, retry once with a shorter query; if it still fails, say that plainly.
- After tool results, answer the user with send_message; do not dump raw tool JSON.`.trim();

export interface WorkerAgentRuntimeOptions {
  /** When false, omit utility/weather/web tools (tests). Default true. */
  readonly informationTools?: boolean;
  readonly observability?: {
    readonly log?: (entry: {
      readonly event: AgentEvent["type"];
      readonly label?: string;
      readonly message?: string;
      readonly toolName?: string;
    }) => void;
  };
  /** Per-turn wide-event sink for createAILogger (tokens/tools/`ai.output`). */
  readonly requestLog?: AiLoggerSink;
  readonly sendMessage?: WorkerAgentSendMessageToolOptions;
  readonly sessionTools?: WorkerAgentSessionToolOptions;
  /** Optional toolpick selection metrics (tools present → prepareStep always on). */
  readonly toolpick?: {
    readonly onSelect?: (metric: ToolpickSelectionMetric) => void;
  };
}

export interface WorkerAgentModelEnv {
  readonly AI_API_KEY: string;
  readonly AI_BASE_URL?: string;
  readonly AI_MODEL?: string;
  readonly ENVIRONMENT: EnvironmentName;
  readonly FIRECRAWL_API_KEY?: string;
}

export interface WorkerAgentTurnDelivery {
  readonly deliveredByTool: boolean;
}

export interface CollectTurnDeliveryOptions {
  readonly onAssistantOutput?: (text: string) => void;
  readonly onEvent?: (event: AgentEvent) => void;
}

export function createConfiguredAgent(
  env: WorkerAgentModelEnv,
  host: AgentHost,
  options: WorkerAgentRuntimeOptions = {}
): Agent {
  const baseURL = env.AI_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const provider = createOpenAICompatible({
    apiKey: env.AI_API_KEY,
    baseURL,
    name: "custom",
    ...aiGatewayRequestHeaders(baseURL),
  });
  const baseModel = provider(env.AI_MODEL?.trim() || DEFAULT_MODEL);
  const model = options.requestLog
    ? wrapModelWithAiLogger(baseModel, options.requestLog)
    : baseModel;

  const plugins: readonly AgentPlugin[] = [
    createTurnObservabilityPlugin({
      label: env.ENVIRONMENT,
      ...(options.observability?.log ? { log: options.observability.log } : {}),
    }),
  ];
  const tools = createWorkerAgentToolSet(env, options);
  const prepareStep = tools
    ? createWorkerAgentPrepareStep(tools, {
        ...(options.toolpick?.onSelect
          ? { onSelect: options.toolpick.onSelect }
          : {}),
      })
    : undefined;

  return new Agent({
    autoCompaction: WORKER_AGENT_AUTO_COMPACTION,
    host,
    instructions: WORKER_AGENT_INSTRUCTIONS,
    model,
    plugins,
    ...(prepareStep ? { prepareStep } : {}),
    ...(tools ? { tools } : {}),
  });
}

function createWorkerAgentToolSet(
  env: WorkerAgentModelEnv,
  options: WorkerAgentRuntimeOptions
): WorkerAgentToolSet | undefined {
  const informationTools = options.informationTools !== false;
  const hasCore = Boolean(options.sendMessage || options.sessionTools);
  if (!(hasCore || informationTools)) {
    return;
  }
  return {
    ...(options.sendMessage ? createWorkerAgentTools(options.sendMessage) : {}),
    ...(options.sessionTools ? createSessionTools(options.sessionTools) : {}),
    ...(informationTools
      ? {
          ...createUtilityTools(),
          ...createWeatherTools(),
          ...createWebTools({
            ...(env.FIRECRAWL_API_KEY?.trim()
              ? { firecrawlApiKey: env.FIRECRAWL_API_KEY.trim() }
              : {}),
          }),
        }
      : {}),
  };
}

export async function collectTurnDelivery(
  run: AgentTurn,
  options: CollectTurnDeliveryOptions = {}
): Promise<WorkerAgentTurnDelivery> {
  const onEvent = options.onEvent;
  const onAssistantOutput = options.onAssistantOutput;
  const events = await drainAgentTurn(
    run,
    onEvent || onAssistantOutput
      ? {
          onEvent: (event) => {
            onEvent?.(event);
            if (event.type === "assistant-output") {
              onAssistantOutput?.(event.text);
            }
          },
        }
      : {}
  );
  const turnError = events.find(
    (event): event is Extract<AgentEvent, { type: "turn-error" }> =>
      event.type === "turn-error"
  );

  if (turnError) {
    throw new Error(turnError.message);
  }

  const deliveredByTool = events.some(
    (event) =>
      event.type === "tool-result" &&
      event.toolName === SEND_MESSAGE_TOOL_NAME &&
      isDeliveredSendMessageToolOutput(event.output)
  );

  return { deliveredByTool };
}

function aiGatewayRequestHeaders(
  baseURL: string
): { readonly headers: Record<string, string> } | Record<string, never> {
  if (!baseURL.includes("gateway.ai.cloudflare.com")) {
    return {};
  }
  return {
    headers: {
      // Wait for first provider byte (reasoning models + tools are slow).
      "cf-aig-request-timeout": String(DEFAULT_AI_GATEWAY_REQUEST_TIMEOUT_MS),
    },
  };
}
