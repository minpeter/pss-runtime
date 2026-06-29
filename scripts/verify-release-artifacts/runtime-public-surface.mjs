export const REQUIRED_RUNTIME_ROOT_EXPORTS = [
  "AgentHost",
  "AgentTurn",
  "RuntimeInput",
];

export const REQUIRED_RUNTIME_EXECUTION_EXPORTS = [
  "CheckpointStore",
  "DurableBackgroundHost",
  "EventStore",
  "ExecutionHost",
  "ExecutionScheduler",
  "ExecutionStore",
  "ExecutionStoreTransaction",
  "NotificationInbox",
  "NotificationRecord",
  "TurnRecord",
  "TurnStore",
  "TurnStatus",
  "RuntimeToolExecutionCheckpoint",
  "RuntimeToolExecutionContext",
  "RuntimeToolExecutionDecision",
  "RuntimeToolRetryPolicy",
  "ToolExecutionNeedsRecoveryError",
];

export const REQUIRED_RUNTIME_MEMORY_EXPORTS = [
  "createInMemoryExecutionHost",
  "MemoryThreadStore",
];

export const REQUIRED_RUNTIME_CLOUDFLARE_EXPORTS = [
  "CloudflareAgentContext",
  "CloudflareAgentContextFactoryOptions",
  "CloudflareAgentContextOptions",
  "CloudflareAgentContextPrefixOptions",
  "AgentTurnDrainResult",
  "AgentTurnDrainStopReason",
  "CloudflareAgentTurnDrainOptions",
  "CloudflareAlarmAgent",
  "CloudflareAlarmDrainSummary",
  "CloudflareDurableObjectFetchOptions",
  "CloudflareDurableObjectId",
  "CloudflareDurableObjectNamespace",
  "CloudflareDurableObjectState",
  "CloudflareDurableObjectStorage",
  "CloudflareDurableObjectStub",
  "CloudflareDurableObjectStubOptions",
  "CloudflareScheduledThreadPrompt",
  "InMemoryCloudflareDurableObjectStorage",
  "ackScheduledCloudflareRun",
  "ackScheduledCloudflareThreadPrompt",
  "createCloudflareAlarmScheduler",
  "createCloudflareAgentContext",
  "createCloudflareDurableObjectHost",
  "drainAgentTurn",
  "drainAgentTurnWithBudget",
  "drainCloudflareAlarm",
  "fetchCloudflareDurableObject",
  "getCloudflareDurableObjectStub",
  "listScheduledCloudflareRuns",
  "listScheduledCloudflareThreadPrompts",
  "rescheduleCloudflareAlarm",
];

export const REQUIRED_RUNTIME_FILE_EXPORTS =
  "FileExecutionStore FileThreadStore NodeFileAgentContext NodeFileAgentContextFactoryOptions NodeFileAgentContextOptions NodeFileExecutionHostOptions NodeFileThreadHostOptions NodeScheduledThreadPrompt NodeScheduledWorkAppendOptions NodeScheduledWorkDrainOptions NodeScheduledWorkDrainResult NodeScheduledWorkListOptions NodeScheduledWorkRunContext ackScheduledNodeRun ackScheduledNodeThreadPrompt appendScheduledNodeRun appendScheduledNodeThreadPrompt createNodeFileAgentContext createNodeFileExecutionHost createNodeFileScheduler createNodeFileThreadHost drainScheduledNodeWork listScheduledNodeRuns listScheduledNodeThreadPrompts".split(
    " "
  );

export const FORBIDDEN_RUNTIME_ROOT_NAMES = [
  ...[
    "AgentMessage AgentModel AgentLoopResult AgentRun AgentRunInput AgentTool AgentTools",
    "BackgroundScheduler BackgroundSchedulerHost CheckpointHost CheckpointStore",
    "CloudflareAgentContext CloudflareAgentContextFactoryOptions CloudflareAgentContextOptions",
    "AgentTurnDrainResult AgentTurnDrainStopReason CloudflareAgentContextPrefixOptions CloudflareAgentTurnDrainOptions CloudflareAlarmAgent",
    "CloudflareAlarmDrainSummary CloudflareDurableObjectFetchOptions CloudflareDurableObjectId",
    "CloudflareDurableObjectNamespace CloudflareDurableObjectState CloudflareDurableObjectStorage",
    "CloudflareDurableObjectStub CloudflareDurableObjectStubOptions CloudflareScheduledThreadPrompt",
    "createInMemoryExecutionHost createCloudflareAlarmScheduler createCloudflareAgentContext",
    "createCloudflareDurableObjectHost CreateLlmOptions DurableBackgroundHost DurableNotificationResumeHost",
    "drainAgentTurn drainAgentTurnWithBudget drainCloudflareAlarm EventHost EventStore ExecutionHost ExecutionScheduler ExecutionStore",
    "ExecutionStoreTransaction ExecutionTransactionHost Llm LlmContext LlmOutput LlmOutputPart",
    "NotificationHost NotificationInbox NotificationRecord fetchCloudflareDurableObject",
    "getCloudflareDurableObjectStub InMemoryCloudflareDurableObjectStorage RunHost RunRecord",
    "MemoryThreadStore",
    "RunInput RunStore RuntimeToolExecutionCheckpoint RuntimeToolExecutionContext",
    "RuntimeToolExecutionDecision RuntimeToolRetryPolicy",
    "FileExecutionStore FileThreadStore FileSessionStore NodeFileAgentContext",
    "NodeFileAgentContextFactoryOptions NodeFileAgentContextOptions NodeFileExecutionHostOptions",
    "NodeFileThreadHostOptions NodeScheduledThreadPrompt NodeScheduledWorkAppendOptions",
    "NodeScheduledWorkDrainOptions NodeScheduledWorkDrainResult NodeScheduledWorkListOptions NodeScheduledWorkRunContext",
    "ackScheduledNodeRun ackScheduledNodeThreadPrompt appendScheduledNodeRun appendScheduledNodeThreadPrompt",
    "createNodeFileAgentContext createNodeFileExecutionHost createNodeFileScheduler createNodeFileThreadHost drainScheduledNodeWork",
    "listScheduledNodeRuns listScheduledNodeThreadPrompts",
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

export const FORBIDDEN_RUNTIME_PUBLIC_PATTERNS = [
  {
    description: "AgentRun.stream() API",
    pattern: /\bstream\(\): AsyncIterable(?:Iterator)?<AgentEvent>/,
  },
  {
    description: "AgentRun.stream() member",
    pattern: /(?:\bstream\(\)\s*\{|AgentRun\.stream\(\))/,
  },
];

export const FORBIDDEN_RUNTIME_MODEL_ADAPTER_NAMES = [
  ["create", "Llm"].join(""),
  ["Runtime", "Create", "Llm", "Options"].join(""),
  ["Runtime", "Llm"].join(""),
  ["Runtime", "Llm", "Context"].join(""),
  ["Runtime", "Llm", "Output"].join(""),
  ["Runtime", "Llm", "Output", "Part"].join(""),
];

export const FORBIDDEN_RUNTIME_SUBAGENT_NAMES = [
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
