import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, packageDistPath, relativeToCwd } from "./shared.mjs";

const REQUIRED_RUNTIME_ROOT_EXPORTS = ["AgentHost", "AgentRun", "RuntimeInput"];
const REQUIRED_RUNTIME_EXECUTION_EXPORTS = [
  "AgentHostCapabilities",
  "BackgroundScheduler",
  "BackgroundSchedulerHost",
  "CheckpointHost",
  "CheckpointStore",
  "createInMemoryExecutionHost",
  "DurableBackgroundHost",
  "DurableNotificationResumeHost",
  "EventHost",
  "EventStore",
  "ExecutionHost",
  "ExecutionScheduler",
  "ExecutionStore",
  "ExecutionStoreTransaction",
  "ExecutionTransactionHost",
  "NotificationHost",
  "NotificationInbox",
  "NotificationRecord",
  "RunHost",
  "RunRecord",
  "RunStore",
  "RuntimeToolExecutionCheckpoint",
  "RuntimeToolExecutionContext",
  "RuntimeToolExecutionDecision",
  "RuntimeToolRetryPolicy",
  "ToolExecutionNeedsRecoveryError",
];
const REQUIRED_RUNTIME_CLOUDFLARE_EXPORTS = [
  "CloudflareAgentContext",
  "CloudflareAgentContextFactoryOptions",
  "CloudflareAgentContextOptions",
  "CloudflareAgentContextPrefixOptions",
  "CloudflareAgentRunDrainOptions",
  "CloudflareAlarmAgent",
  "CloudflareAlarmDrainSummary",
  "CloudflareDurableObjectFetchOptions",
  "CloudflareDurableObjectId",
  "CloudflareDurableObjectNamespace",
  "CloudflareDurableObjectState",
  "CloudflareDurableObjectStorage",
  "CloudflareDurableObjectStub",
  "CloudflareDurableObjectStubOptions",
  "CloudflareScheduledSessionPrompt",
  "InMemoryCloudflareDurableObjectStorage",
  "ackScheduledCloudflareRun",
  "ackScheduledCloudflareSessionPrompt",
  "createCloudflareAlarmScheduler",
  "createCloudflareAgentContext",
  "createCloudflareDurableObjectHost",
  "drainAgentRun",
  "drainCloudflareAlarm",
  "fetchCloudflareDurableObject",
  "getCloudflareDurableObjectStub",
  "listScheduledCloudflareRuns",
  "listScheduledCloudflareSessionPrompts",
  "rescheduleCloudflareAlarm",
];
const FORBIDDEN_RUNTIME_ROOT_NAMES = [
  ...[
    "AgentMessage AgentModel AgentLoopResult AgentRunInput AgentTool AgentTools",
    "AgentHostCapabilities BackgroundScheduler BackgroundSchedulerHost CheckpointHost CheckpointStore",
    "CloudflareAgentContext CloudflareAgentContextFactoryOptions CloudflareAgentContextOptions",
    "CloudflareAgentContextPrefixOptions CloudflareAgentRunDrainOptions CloudflareAlarmAgent",
    "CloudflareAlarmDrainSummary CloudflareDurableObjectFetchOptions CloudflareDurableObjectId",
    "CloudflareDurableObjectNamespace CloudflareDurableObjectState CloudflareDurableObjectStorage",
    "CloudflareDurableObjectStub CloudflareDurableObjectStubOptions CloudflareScheduledSessionPrompt",
    "createInMemoryExecutionHost createCloudflareAlarmScheduler createCloudflareAgentContext",
    "createCloudflareDurableObjectHost CreateLlmOptions DurableBackgroundHost DurableNotificationResumeHost",
    "drainCloudflareAlarm EventHost EventStore ExecutionHost ExecutionScheduler ExecutionStore",
    "ExecutionStoreTransaction ExecutionTransactionHost Llm LlmContext LlmOutput LlmOutputPart",
    "NotificationHost NotificationInbox NotificationRecord fetchCloudflareDurableObject",
    "getCloudflareDurableObjectStub InMemoryCloudflareDurableObjectStorage RunHost RunRecord",
    "RunInput RunStore RuntimeToolExecutionCheckpoint RuntimeToolExecutionContext",
    "RuntimeToolExecutionDecision RuntimeToolRetryPolicy",
  ].flatMap((names) => names.split(" ")),
  ["create", "Llm"].join(""),
  ["Runtime", "Create", "Llm", "Options"].join(""),
  ["Runtime", "Llm"].join(""),
  ["Runtime", "Llm", "Context"].join(""),
  ["Runtime", "Llm", "Output"].join(""),
  ["Runtime", "Llm", "Output", "Part"].join(""),
  "runAgentLoop",
  "ToolExecutionNeedsRecoveryError",
  "SessionHost",
];
const FORBIDDEN_RUNTIME_PUBLIC_PATTERNS = [
  {
    description: "AgentRun.stream() API",
    pattern: /\bstream\(\): AsyncIterable(?:Iterator)?<AgentEvent>/,
  },
  {
    description: "AgentRun.stream() member",
    pattern: /(?:\bstream\(\)\s*\{|AgentRun\.stream\(\))/,
  },
];
const FORBIDDEN_RUNTIME_MODEL_ADAPTER_NAMES = [
  ["create", "Llm"].join(""),
  ["Runtime", "Create", "Llm", "Options"].join(""),
  ["Runtime", "Llm"].join(""),
  ["Runtime", "Llm", "Context"].join(""),
  ["Runtime", "Llm", "Output"].join(""),
  ["Runtime", "Llm", "Output", "Part"].join(""),
];
const FORBIDDEN_RUNTIME_SUBAGENT_NAMES = [
  ["Subagent", "Definition"].join(""),
  ["resume", "Background", "Child", "Run"].join(""),
  ["Background", "Child", "Agent"].join(""),
  ["Subagent", "Status", "Agent", "Event"].join(""),
  ["is", "Subagent", "Status", "Agent", "Event"].join(""),
  ["background", "Subagents"].join(""),
  ["background", "subagent"].join("-"),
  ["subagent", "job", "start"].join("-"),
  ["subagent", "job", "update"].join("-"),
  ["subagent", "job", "end"].join("-"),
  ["create", "Subagent", "Tools"].join(""),
  ["register", "Subagents"].join(""),
];
const RUNTIME_PUBLIC_ARTIFACT_RE = /\.(?:d\.ts|[cm]?js)$/;

export function findRuntimeDeclarationLeaks({ cwd, packages }) {
  if (!packages.includes("runtime")) {
    return [];
  }

  return [
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(packageDistPath(cwd, "runtime"), "index.d.ts"),
      requiredExports: REQUIRED_RUNTIME_ROOT_EXPORTS,
      surface: "root",
    }),
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(packageDistPath(cwd, "runtime"), "execution", "index.d.ts"),
      requiredExports: REQUIRED_RUNTIME_EXECUTION_EXPORTS,
      surface: "execution",
    }),
    ...findRuntimeDeclarationExportLeaks({
      cwd,
      file: join(packageDistPath(cwd, "runtime"), "cloudflare", "index.d.ts"),
      requiredExports: REQUIRED_RUNTIME_CLOUDFLARE_EXPORTS,
      surface: "cloudflare",
    }),
    ...findRuntimePublicPatternLeaks({ cwd }),
  ];
}

function findRuntimePublicPatternLeaks({ cwd }) {
  const errors = [];
  const distPath = packageDistPath(cwd, "runtime");
  const files = listFiles(distPath, (file) =>
    RUNTIME_PUBLIC_ARTIFACT_RE.test(file)
  );

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { description, pattern } of FORBIDDEN_RUNTIME_PUBLIC_PATTERNS) {
      if (pattern.test(text)) {
        errors.push(`${relativeToCwd(cwd, file)}: exposes ${description}`);
      }
    }
    for (const name of FORBIDDEN_RUNTIME_SUBAGENT_NAMES) {
      if (text.includes(name)) {
        errors.push(
          `${relativeToCwd(cwd, file)}: exposes runtime-owned subagent name ${name}`
        );
      }
    }
    if (file.endsWith(`${join("runtime", "dist", "llm.d.ts")}`)) {
      for (const name of FORBIDDEN_RUNTIME_MODEL_ADAPTER_NAMES) {
        if (text.includes(name)) {
          errors.push(
            `${relativeToCwd(cwd, file)}: exposes removed runtime LLM adapter name ${name}`
          );
        }
      }
    }
  }

  return errors;
}

function findRuntimeDeclarationExportLeaks({
  cwd,
  file,
  requiredExports,
  surface,
}) {
  if (!existsSync(file)) {
    return [
      `${relativeToCwd(cwd, file)}: missing ${surface} runtime declaration`,
    ];
  }

  const text = readFileSync(file, "utf8");
  const errors = [];

  if (surface === "root") {
    for (const name of FORBIDDEN_RUNTIME_ROOT_NAMES) {
      if (hasDeclarationToken(text, name)) {
        errors.push(
          `${relativeToCwd(cwd, file)}: root declaration exposes internal runtime name ${name}`
        );
      }
    }
  }

  for (const name of requiredExports) {
    if (!text.includes(name)) {
      errors.push(
        `${relativeToCwd(cwd, file)}: missing explicit ${surface} runtime export ${name}`
      );
    }
  }
  return errors;
}

function hasDeclarationToken(text, token) {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
