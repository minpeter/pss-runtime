import { describe, expect, it } from "vitest";
import {
  readAgentApiRoute,
  readAgentTurnRequest,
  readSandboxFileEditRequest,
} from "./agent-api";

describe("agent worker versioned api", () => {
  it("routes a conversation turn path to an isolated worker route", () => {
    // Given: a Cloudflare-style stable path for one conversation.
    const url =
      "https://worker.example/v1/tenants/tenant-a/users/user-a/conversations/ticket-1/turn";

    // When: the Worker parses the path.
    const route = readAgentApiRoute(url);

    // Then: the route identifies the operation and durable object instance.
    expect(route).toMatchObject({
      kind: "turn",
      workerRoute: {
        conversationId: "ticket-1",
        objectName: "support-agent:tenant-a:ticket-1:user-a",
        sessionKey: "tenant:tenant-a:conversation:ticket-1:user:user-a",
        tenantId: "tenant-a",
        userId: "user-a",
      },
    });
  });

  it("parses a versioned turn body from path identity", async () => {
    // Given: the stable route carries tenant, user, and conversation identity.
    const route = readAgentApiRoute(
      "https://worker.example/v1/tenants/tenant-a/users/user-a/conversations/ticket-1/turn"
    );
    if (route?.kind !== "turn") {
      throw new Error("turn route was not parsed");
    }
    const request = new Request("https://worker.example/unused", {
      body: JSON.stringify({
        input: "hello from path route",
        scenario: "foreground-basic",
      }),
      method: "POST",
    });

    // When: the request body is read for the versioned API.
    const parsed = await readAgentTurnRequest(request, route.workerRoute);

    // Then: the resulting TurnRequest is still the existing runtime shape.
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        conversationId: "ticket-1",
        input: "hello from path route",
        scenario: "foreground-basic",
        tenantId: "tenant-a",
        userId: "user-a",
      },
    });
  });

  it("routes a Cloudflare Agents-style per-user path", () => {
    const route = readAgentApiRoute(
      "https://worker.example/agents/pss-agent-worker/user-a/turn?tenant=tenant-a&conversation=ticket-1"
    );

    expect(route).toMatchObject({
      kind: "turn",
      workerRoute: {
        conversationId: "ticket-1",
        objectName: "support-agent:tenant-a:ticket-1:user-a",
        tenantId: "tenant-a",
        userId: "user-a",
      },
    });
  });

  it("parses a bounded sandbox file edit request", async () => {
    // Given: a per-user sandbox demo body.
    const request = new Request("https://worker.example/unused", {
      body: JSON.stringify({
        content: "print('hello from sandbox')",
        filename: "hello.py",
      }),
      method: "POST",
    });

    // When: the body is parsed.
    const parsed = await readSandboxFileEditRequest(request);

    // Then: the app produces a workspace-confined file edit.
    expect(parsed).toEqual({
      ok: true,
      status: 200,
      value: {
        content: "print('hello from sandbox')",
        filename: "hello.py",
        path: "/workspace/hello.py",
      },
    });
  });
});
