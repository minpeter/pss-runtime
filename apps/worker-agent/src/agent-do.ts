import type { Agent } from "@minpeter/pss-runtime";
import type {
  CloudflareAgentsFiberRecoveryContext,
  CloudflareAgentsFiberRecoveryResult,
  CloudflarePlatformContext,
} from "@minpeter/pss-runtime/platform/cloudflare";
import { createCloudflarePlatformContext } from "@minpeter/pss-runtime/platform/cloudflare";
import { installCloudflareImageCodecs } from "@minpeter/pss-runtime/platform/cloudflare/image-codecs";
import { Agent as CloudflareAgent } from "agents";

import { createConfiguredAgent } from "./agent";
import { createSendMessageToolOptions } from "./agent-do-send-message";
import { AgentDoSession } from "./agent-do-session";
import { AgentDoSessionRoutes } from "./agent-do-session-routes";
import { AgentDoTurn } from "./agent-do-turn";
import {
  AgentDoState,
  SESSION_REPLAY_PATH,
  SESSION_STREAM_PATH,
  SESSION_SUBMIT_PATH,
} from "./agent-do-types";
import type { Env } from "./env";
import {
  createSessionIndexClient,
  isSessionIndexPath,
} from "./session-index-client";
import { handleSessionIndexRequest } from "./session-index-routes";
import {
  createSessionTranscriptClient,
  isSessionTranscriptPath,
} from "./session-transcript-client";
import { ensureWorkerLogger } from "./worker-log";

installCloudflareImageCodecs();

export class AgentDurableObject extends CloudflareAgent<Env> {
  readonly #platform: CloudflarePlatformContext<Agent>;
  readonly #session: AgentDoSession;
  readonly #sessionRoutes: AgentDoSessionRoutes;
  readonly #state = new AgentDoState();
  readonly #turn: AgentDoTurn;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ensureWorkerLogger({
      environment: env.ENVIRONMENT,
      version: env.CF_VERSION_METADATA?.id,
    });
    const sessionIndexClient = createSessionIndexClient(env);
    const sessionTranscriptClient = createSessionTranscriptClient(env);
    this.#platform = createCloudflarePlatformContext({
      cloudflareAgent: this,
      createAgent: ({ env: agentEnv, host }) =>
        createConfiguredAgent(agentEnv, host, {
          sendMessage: createSendMessageToolOptions(agentEnv, () => undefined),
        }),
      drain: {
        onEvent: () => this.#state.sessionEventLive.publish(),
      },
      durableObjectContext: this.ctx,
      env,
    });
    this.#session = new AgentDoSession({
      env,
      platform: this.#platform,
      sessionIndexClient,
      sessionTranscriptClient,
      state: this.#state,
      storage: ctx.storage,
    });
    this.#sessionRoutes = new AgentDoSessionRoutes({
      platform: this.#platform,
      session: this.#session,
      state: this.#state,
      storage: ctx.storage,
    });
    this.#turn = new AgentDoTurn({
      env,
      session: this.#session,
      sessionIndexClient,
      state: this.#state,
    });
  }

  async resumePssRuntimeFiber(payload: unknown): Promise<void> {
    await this.#session.restoreBinding();
    try {
      await this.#platform.resumeScheduledFiber(payload);
    } finally {
      this.#state.sessionEventLive.publish();
    }
  }

  override async onFiberRecovered(
    ctx: CloudflareAgentsFiberRecoveryContext
  ): Promise<undefined | CloudflareAgentsFiberRecoveryResult> {
    try {
      const result = await this.#platform.recoverFiber(ctx);
      if (result === false) {
        return;
      }
      return result;
    } finally {
      this.#state.sessionEventLive.publish();
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === SESSION_STREAM_PATH) {
      if (request.method !== "GET") {
        return new Response("method not allowed", { status: 405 });
      }
      return await this.#sessionRoutes.handleEventStream(request);
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    if (pathname === SESSION_SUBMIT_PATH) {
      return await this.#sessionRoutes.handleSubmit(request);
    }
    if (pathname === SESSION_REPLAY_PATH) {
      return await this.#sessionRoutes.handleReplay(request);
    }
    if (isSessionIndexPath(pathname)) {
      return await handleSessionIndexRequest({
        pathname,
        request,
        store: this.#session.sessionIndex(),
      });
    }
    if (isSessionTranscriptPath(pathname)) {
      return await this.#sessionRoutes.handleTranscript(request);
    }

    return await this.#turn.handle(request);
  }
}
