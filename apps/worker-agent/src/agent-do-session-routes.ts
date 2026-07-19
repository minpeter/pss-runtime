import type { Agent } from "@minpeter/pss-runtime";
import { dispatchAgentNotification } from "@minpeter/pss-runtime/execution";
import type { CloudflarePlatformContext } from "@minpeter/pss-runtime/platform/cloudflare";

import { WORKER_AGENT_NAMESPACE } from "./agent";
import type { AgentDoSession } from "./agent-do-session";
import {
  type AgentDoState,
  requireRuntimeThread,
  SESSION_BINDING_STORAGE_KEY,
  type SessionBindingRecord,
} from "./agent-do-types";
import {
  CHANNEL_DURABLE_OBJECT_THREAD_KEY,
  type ChannelAddress,
  durableObjectChannelBinding,
} from "./channel";
import {
  parseSessionChannel,
  parseThreadEventCursor,
  ReplayEventsRequestSchema,
  SubmitTurnRequestSchema,
  type ThreadEventCursor,
} from "./session-contract";
import { createSessionEventStreamResponse } from "./session-events";
import { replayDurableThreadEvents } from "./session-runtime";
import { createThreadStoreSessionTranscriptReader } from "./session-transcript";
import { SessionTranscriptReadRequestSchema } from "./session-transcript-client";

export interface AgentDoSessionRoutesOptions {
  readonly platform: CloudflarePlatformContext<Agent>;
  readonly session: AgentDoSession;
  readonly state: AgentDoState;
  readonly storage: DurableObjectStorage;
}

export class AgentDoSessionRoutes {
  readonly #platform: CloudflarePlatformContext<Agent>;
  readonly #session: AgentDoSession;
  readonly #state: AgentDoState;
  readonly #storage: DurableObjectStorage;

  constructor(options: AgentDoSessionRoutesOptions) {
    this.#platform = options.platform;
    this.#session = options.session;
    this.#state = options.state;
    this.#storage = options.storage;
  }

  async handleEventStream(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const serializedChannel = url.searchParams.get("channel");
    if (!serializedChannel) {
      return new Response("channel required", { status: 400 });
    }

    let channel: ChannelAddress;
    let after: ThreadEventCursor | undefined;
    try {
      channel = parseSessionChannel(serializedChannel);
      const serializedAfter = url.searchParams.get("after");
      after =
        serializedAfter === null
          ? undefined
          : parseThreadEventCursor(serializedAfter);
    } catch {
      return new Response("invalid session event stream", { status: 400 });
    }
    this.#state.channel = channel;
    this.#state.sessionScopeKey =
      url.searchParams.get("sessionScopeKey")?.trim() || undefined;
    await this.#session.ensureTurnSession(durableObjectChannelBinding(channel));
    const thread = requireRuntimeThread(this.#session.runtimeThread());

    return createSessionEventStreamResponse({
      ...(after ? { after } : {}),
      live: this.#state.sessionEventLive,
      replay: (cursor) =>
        replayDurableThreadEvents(thread, {
          ...(cursor ? { after: cursor } : {}),
          limit: 100,
        }),
    });
  }

  async handleSubmit(request: Request): Promise<Response> {
    const body = await readRequestJson(request);
    const parsed = SubmitTurnRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid session turn", { status: 400 });
    }

    const channelId = parsed.data.channel.id.trim();
    const text = parsed.data.text.trim();
    if (!(channelId && text)) {
      return new Response("invalid session turn", { status: 400 });
    }
    const channel = { id: channelId, kind: parsed.data.channel.kind };
    const sessionScopeKey = parsed.data.sessionScopeKey?.trim();
    this.#state.channel = channel;
    this.#state.sessionScopeKey = sessionScopeKey || undefined;
    await this.#storage.put(SESSION_BINDING_STORAGE_KEY, {
      channel,
      ...(sessionScopeKey ? { sessionScopeKey } : {}),
    } satisfies SessionBindingRecord);

    const admitted = await dispatchAgentNotification({
      host: this.#platform.host(),
      idempotencyKey: parsed.data.idempotencyKey?.trim() || crypto.randomUUID(),
      input: { text, type: "user-input" },
      namespace: WORKER_AGENT_NAMESPACE,
      threadKey: CHANNEL_DURABLE_OBJECT_THREAD_KEY,
    });
    return Response.json({
      accepted: true,
      runId: admitted.runId,
      threadKey: CHANNEL_DURABLE_OBJECT_THREAD_KEY,
    });
  }

  async handleReplay(request: Request): Promise<Response> {
    const body = await readRequestJson(request);
    const parsed = ReplayEventsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid session replay", { status: 400 });
    }

    const channelId = parsed.data.channel.id.trim();
    if (!channelId) {
      return new Response("invalid session replay", { status: 400 });
    }
    const channel = { id: channelId, kind: parsed.data.channel.kind };
    this.#state.channel = channel;
    this.#state.sessionScopeKey =
      parsed.data.sessionScopeKey?.trim() || undefined;
    await this.#session.ensureTurnSession(durableObjectChannelBinding(channel));
    const thread = requireRuntimeThread(this.#session.runtimeThread());

    return Response.json(
      await replayDurableThreadEvents(thread, {
        ...(parsed.data.after ? { after: parsed.data.after } : {}),
        ...(parsed.data.limit === undefined
          ? {}
          : { limit: parsed.data.limit }),
      })
    );
  }

  async handleTranscript(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    const parsed = SessionTranscriptReadRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response("invalid transcript read", { status: 400 });
    }

    const transcript = await createThreadStoreSessionTranscriptReader({
      resolveThreadKey: () => CHANNEL_DURABLE_OBJECT_THREAD_KEY,
      store: this.#platform.host().store.threads,
    }).read(parsed.data.conversationKey, {
      ...(parsed.data.before === undefined
        ? {}
        : { before: parsed.data.before }),
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    });

    return Response.json(
      transcript
        ? { ...transcript, found: true }
        : { conversationKey: parsed.data.conversationKey, found: false }
    );
  }
}

async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return;
  }
}
