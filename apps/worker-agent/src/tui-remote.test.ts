import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createRemoteTuiDeliveryClient } from "./tui-remote";

const serverHandles: CloseableServer[] = [];

describe("remote TUI tRPC client", () => {
  afterEach(async () => {
    await Promise.all(serverHandles.splice(0).map((server) => server.close()));
  });

  it("posts turns to the tRPC procedure path with bearer auth", async () => {
    const requests: CapturedRequest[] = [];
    const server = await startServer(async (request) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        body: await request.text(),
        pathname: new URL(request.url).pathname,
        search: new URL(request.url).searchParams,
      });

      return Response.json({
        result: {
          data: {
            delivered: true,
            messages: [
              {
                channel: "tui:local",
                messageId: "tui-1",
                text: "remote ok",
              },
            ],
          },
        },
      });
    });
    const client = createRemoteTuiDeliveryClient({
      channel: { id: "local", kind: "tui" },
      endpoint: `${server.origin}/trpc`,
      token: "secret",
    });

    await expect(client.deliver("hello remote")).resolves.toEqual({
      delivered: true,
      messages: [
        {
          channel: "tui:local",
          messageId: "tui-1",
          text: "remote ok",
        },
      ],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: "Bearer secret",
      pathname: "/trpc/tui.turn",
    });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      channel: { id: "local", kind: "tui" },
      text: "hello remote",
    });
  });
});

interface CapturedRequest {
  readonly authorization: string | null;
  readonly body: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
}

interface CloseableServer {
  close(): Promise<void>;
  readonly origin: string;
}

async function startServer(
  handler: (request: Request) => Promise<Response>
): Promise<CloseableServer> {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", async () => {
      const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
        body:
          incoming.method === "GET" || incoming.method === "HEAD"
            ? null
            : Buffer.concat(chunks),
        headers: headersFromIncomingRequest(incoming.headers),
        method: incoming.method,
      });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected server address.");
  }

  const closeable = {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  } satisfies CloseableServer;
  serverHandles.push(closeable);
  return closeable;
}

function headersFromIncomingRequest(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
): Headers {
  const normalizedHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalizedHeaders.set(name, value);
      continue;
    }
    if (value) {
      normalizedHeaders.set(name, value.join(", "));
    }
  }
  return normalizedHeaders;
}
