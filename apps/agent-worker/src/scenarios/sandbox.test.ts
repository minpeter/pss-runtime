import { InMemoryCloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import { describe, expect, it } from "vitest";
import { routeWorkerRequest } from "../request/route";
import { parseTurnBody } from "../request/schema";
import { runStressScenario } from ".";

const route = routeWorkerRequest("https://worker.example/turn", {
  conversationId: "ticket-1",
  tenantId: "tenant-a",
  userId: "user-a",
});

if (!route) {
  throw new Error("test route must be valid");
}

describe("user sandbox file edit scenario", () => {
  it("models isolated per-user file edits with storage-backed evidence", async () => {
    const parsed = parseTurnBody({
      conversationId: route.conversationId,
      input: "replace the project note",
      scenario: "user-sandbox-file-edit",
      tenantId: route.tenantId,
      userId: route.userId,
    });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    const result = await runStressScenario({
      env: {},
      request: parsed.value,
      route,
      storage: new InMemoryCloudflareDurableObjectStorage(),
    });

    expect(result.markers).toEqual(
      expect.arrayContaining([
        "scenario:user-sandbox-file-edit",
        "sandbox:spawned:user:user-a",
        "sandbox:file-written:/workspace/project/notes.md",
        "sandbox:isolation:pass",
      ])
    );
    expect(result.evidence).toEqual({
      after: "replace the project note",
      before: null,
      editedFile: "/workspace/project/notes.md",
      isolationProbe: {
        otherUserCanReadFile: false,
        otherUserSandboxId: "user:user-a-other",
      },
      sandboxBackend: "durable-object-storage-simulation",
      sandboxId: "user:user-a",
      type: "user-sandbox-file-edit",
    });
  });
});
