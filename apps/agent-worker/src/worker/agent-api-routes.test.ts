import { describe, expect, it } from "vitest";
import {
  type WorkerAgentApiEnv,
  workerAgentApiRouteResponse,
} from "./agent-api-routes";

describe("worker agent API routes", () => {
  it("returns a structured 503 when a local Sandbox container is still starting", async () => {
    const sandboxBinding = {} as NonNullable<WorkerAgentApiEnv["Sandbox"]>;
    const response = await workerAgentApiRouteResponse({
      env: { Sandbox: sandboxBinding },
      request: new Request(
        "https://worker.example/v1/tenants/tenant-a/users/user-a/sandbox/file-edit",
        {
          body: JSON.stringify({
            content: 'print("hello")',
            filename: "hello.py",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      ),
      sandboxFactory: () => ({
        exec: async () => ({
          exitCode: 0,
          stdout: "",
          success: true,
        }),
        mkdir: () =>
          Promise.reject(
            new Error("Container is starting. Please retry in a moment.")
          ),
        readFile: async (path) => ({ content: "", path }),
        writeFile: async () => ({}),
      }),
    });

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({
      error: "Cloudflare Sandbox container is unavailable.",
      reason: "Container is starting. Please retry in a moment.",
      retryAfterSeconds: 5,
      sandboxConfigured: true,
      sandboxName: "tenant-tenant-a-user-user-a",
      tenantId: "tenant-a",
      userId: "user-a",
    });
  });
});
