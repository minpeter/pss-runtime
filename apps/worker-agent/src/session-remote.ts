import { createTRPCClient, httpLink } from "@trpc/client";

import {
  type ReplayEventsRequest,
  type ReplayEventsResponse,
  ReplayEventsResponseSchema,
  type SubmitTurnRequest,
  type SubmitTurnResponse,
  SubmitTurnResponseSchema,
} from "./session-contract";
import type { WorkerAgentRouter } from "./tui-rpc";

export interface RemoteSessionClient {
  replayEvents(input: ReplayEventsRequest): Promise<ReplayEventsResponse>;
  submitTurn(input: SubmitTurnRequest): Promise<SubmitTurnResponse>;
}

export interface RemoteSessionClientConfig {
  readonly endpoint: string;
  readonly token?: string;
}

export function createRemoteSessionClient(
  config: RemoteSessionClientConfig
): RemoteSessionClient {
  const client = createTRPCClient<WorkerAgentRouter>({
    links: [
      httpLink({
        headers: () =>
          config.token ? { authorization: `Bearer ${config.token}` } : {},
        url: config.endpoint,
      }),
    ],
  });

  return {
    replayEvents: async (input) => {
      const response: unknown = await client.session.replayEvents.query(input);
      return ReplayEventsResponseSchema.parse(response);
    },
    submitTurn: async (input) => {
      const response: unknown = await client.session.submitTurn.mutate(input);
      return SubmitTurnResponseSchema.parse(response);
    },
  };
}
