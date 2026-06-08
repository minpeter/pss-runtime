import type { AgentEvent } from "@minpeter/pss-runtime";
import type { CloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import type { RunStressScenarioOptions } from ".";
import { type StressScenarioResult, scenarioResult } from "./result";

const editedFile = "/workspace/project/notes.md";
const sandboxBackend = "durable-object-storage-simulation";

export async function runUserSandboxFileEditScenario(
  options: RunStressScenarioOptions
): Promise<StressScenarioResult> {
  const sandboxId = userSandboxId(options.request.userId);
  const otherUserSandboxId = userSandboxId(`${options.request.userId}-other`);
  const fileContent = requestFileContent(options.request.input);
  const fileKey = sandboxFileKey({
    filePath: editedFile,
    sandboxId,
    tenantId: options.request.tenantId,
  });
  const otherUserFileKey = sandboxFileKey({
    filePath: editedFile,
    sandboxId: otherUserSandboxId,
    tenantId: options.request.tenantId,
  });
  const before = (await options.storage.get<string>(fileKey)) ?? null;

  await writeSandboxFile(options.storage, fileKey, fileContent);

  const after = (await options.storage.get<string>(fileKey)) ?? "";
  const otherUserCanReadFile =
    (await options.storage.get<string>(otherUserFileKey)) !== undefined;
  const events: readonly AgentEvent[] = [
    {
      text: `edited ${editedFile} in ${sandboxId}`,
      type: "assistant-text",
    },
  ];

  return scenarioResult(
    "user-sandbox-file-edit",
    events,
    [
      "scenario:user-sandbox-file-edit",
      `sandbox:spawned:${sandboxId}`,
      `sandbox:file-written:${editedFile}`,
      otherUserCanReadFile
        ? "sandbox:isolation:fail"
        : "sandbox:isolation:pass",
    ],
    undefined,
    options.request.stress.summaryEvents,
    {
      after,
      before,
      editedFile,
      isolationProbe: {
        otherUserCanReadFile,
        otherUserSandboxId,
      },
      sandboxBackend,
      sandboxId,
      type: "user-sandbox-file-edit",
    }
  );
}

function userSandboxId(userId: string): string {
  return `user:${userId}`;
}

function sandboxFileKey({
  filePath,
  sandboxId,
  tenantId,
}: {
  readonly filePath: string;
  readonly sandboxId: string;
  readonly tenantId: string;
}): string {
  return [
    "__pss_worker_sandbox",
    encodeURIComponent(tenantId),
    encodeURIComponent(sandboxId),
    encodeURIComponent(filePath),
  ].join(":");
}

async function writeSandboxFile(
  storage: CloudflareDurableObjectStorage,
  key: string,
  content: string
): Promise<void> {
  await storage.put(key, content);
}

function requestFileContent(
  input: RunStressScenarioOptions["request"]["input"]
): string {
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return `array input with ${input.length} parts`;
  }
  if ("content" in input && Array.isArray(input.content)) {
    return `multipart input with ${input.content.length} parts`;
  }
  return "structured user input";
}
