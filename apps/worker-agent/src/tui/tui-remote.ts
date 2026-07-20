import { createTRPCClient, httpLink } from "@trpc/client";

import type { WorkerAgentDeliveryResponse } from "../agent/agent-do-delivery";
import type { ChannelAddress } from "../channel";
import { TUI_SESSION_SCOPE_KEY, TuiTurnOutputSchema } from "./tui-contract";
import type { WorkerAgentRouter } from "./tui-rpc";

const REMOTE_TUI_TIMEOUT_MS = 120_000;

export interface RemoteTuiDeliveryClient {
  deliver(text: string): Promise<WorkerAgentDeliveryResponse>;
}

export interface RemoteTuiDeliveryClientConfig {
  readonly channel: ChannelAddress;
  readonly endpoint: string;
  readonly token?: string;
}

export function createRemoteTuiDeliveryClient(
  config: RemoteTuiDeliveryClientConfig
): RemoteTuiDeliveryClient {
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
    deliver: (text) => requestRemoteTuiDelivery({ client, config, text }),
  };
}

export async function requestRemoteTuiDelivery({
  client,
  config,
  text,
}: RemoteTuiDeliveryRequest): Promise<WorkerAgentDeliveryResponse> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), REMOTE_TUI_TIMEOUT_MS);
  try {
    const delivery = await client.tui.turn.mutate(
      {
        channel: config.channel,
        sessionScopeKey: TUI_SESSION_SCOPE_KEY,
        text,
      },
      { signal: abort.signal }
    );

    return TuiTurnOutputSchema.parse(delivery);
  } finally {
    clearTimeout(timeout);
  }
}

interface RemoteTuiDeliveryRequest {
  readonly client: ReturnType<typeof createTRPCClient<WorkerAgentRouter>>;
  readonly config: RemoteTuiDeliveryClientConfig;
  readonly text: string;
}
