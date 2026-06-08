import { type ScenarioId, scenarioIds } from "../request/schema";

export interface ScenarioCatalogEntry {
  readonly cloudflareFeatures: readonly string[];
  readonly description: string;
  readonly id: ScenarioId;
  readonly route: "POST /runs";
  readonly title: string;
}

interface ScenarioDetails {
  readonly cloudflareFeatures: readonly string[];
  readonly description: string;
  readonly title: string;
}

const scenarioDetails: Record<ScenarioId, ScenarioDetails> = {
  "background-cancel": {
    cloudflareFeatures: ["Durable Object storage"],
    description: "Cancels background work without relying on waitUntil.",
    title: "Background Cancellation",
  },
  "background-output": {
    cloudflareFeatures: ["Durable Object alarm", "durable queue"],
    description: "Launches background work and resumes it from an alarm.",
    title: "Background Output",
  },
  "blocking-subagent": {
    cloudflareFeatures: ["nested agent run"],
    description: "Runs a blocking subagent inside the foreground turn.",
    title: "Blocking Subagent",
  },
  "budget-guard": {
    cloudflareFeatures: ["request budget"],
    description: "Exercises app-level guardrails below platform ceilings.",
    title: "Budget Guard",
  },
  "cancel-stale-child": {
    cloudflareFeatures: ["Durable Object storage", "durable queue"],
    description: "Cancels stale queued child work after parent deletion.",
    title: "Cancel Stale Child",
  },
  "checkpoint-size-guard": {
    cloudflareFeatures: ["checkpoint budget"],
    description: "Rejects checkpoint payloads before they grow too large.",
    title: "Checkpoint Size Guard",
  },
  "duplicate-alarm": {
    cloudflareFeatures: ["Durable Object alarm"],
    description: "Proves duplicate alarm delivery is idempotent.",
    title: "Duplicate Alarm",
  },
  "durable-background": {
    cloudflareFeatures: ["Durable Object alarm", "durable queue"],
    description: "Schedules background subagent work for later resume.",
    title: "Durable Background Subagent",
  },
  "fanout-guard": {
    cloudflareFeatures: ["subrequest budget"],
    description: "Rejects fanout above the app budget.",
    title: "Fanout Guard",
  },
  "foreground-basic": {
    cloudflareFeatures: ["HTTP", "Durable Object storage"],
    description: "Runs a simple foreground turn and drains run.events().",
    title: "Foreground Basic",
  },
  "large-history-guard": {
    cloudflareFeatures: ["storage budget"],
    description: "Bounds reconstructed conversation history.",
    title: "Large History Guard",
  },
  "long-running-pingpong": {
    cloudflareFeatures: ["Durable Object alarm", "durable queue"],
    description: "Time-compresses over five minutes through alarm handoffs.",
    title: "Long-Running Ping-Pong",
  },
  "multipart-input": {
    cloudflareFeatures: ["HTTP"],
    description: "Accepts bounded text, image, and file input parts.",
    title: "Multipart Input",
  },
  "plugin-events": {
    cloudflareFeatures: ["observability"],
    description: "Counts plugin lifecycle events during a turn.",
    title: "Plugin Events",
  },
  "request-rejection": {
    cloudflareFeatures: ["request budget"],
    description: "Exercises deterministic request validation failures.",
    title: "Request Rejection",
  },
  "resume-retry": {
    cloudflareFeatures: ["Durable Object alarm", "durable queue"],
    description: "Leaves retryable alarm work scheduled after failure.",
    title: "Resume Retry",
  },
  "steer-step-end": {
    cloudflareFeatures: ["streaming events"],
    description: "Steers a session from a step-end event boundary.",
    title: "Steer Step End",
  },
  "tool-choice": {
    cloudflareFeatures: ["tool execution"],
    description: "Exercises deterministic tool choice handling.",
    title: "Tool Choice",
  },
  "user-sandbox-file-edit": {
    cloudflareFeatures: ["Sandbox SDK pattern", "per-user isolation"],
    description: "Spawns a user-scoped sandbox and edits an isolated file.",
    title: "User Sandbox File Edit",
  },
};

export const scenarioCatalog: readonly ScenarioCatalogEntry[] = scenarioIds.map(
  (id) => ({
    id,
    route: "POST /runs",
    ...scenarioDetails[id],
  })
);

export function findScenarioCatalogEntry(
  id: string
): ScenarioCatalogEntry | undefined {
  return scenarioCatalog.find((entry) => entry.id === id);
}

export function llmsText(baseUrl: string): string {
  return [
    "# pss-agent-worker",
    "",
    `- [Markdown docs](${baseUrl}/docs/index.md)`,
    `- [OpenAPI document](${baseUrl}/openapi.json)`,
    `- [Scenario catalog](${baseUrl}/scenarios)`,
    "",
    "Use POST /runs to create a deterministic Cloudflare stress run.",
    "Use /v1/tenants/{tenantId}/users/{userId}/... for path-stable agent calls.",
  ].join("\n");
}

export function docsIndexMarkdown(baseUrl: string): string {
  const lines = scenarioCatalog.map(
    (entry) =>
      `- ${entry.id}: ${entry.description} (${entry.cloudflareFeatures.join(", ")})`
  );
  return [
    "# pss-agent-worker",
    "",
    `OpenAPI: ${baseUrl}/openapi.json`,
    `Scenarios: ${baseUrl}/scenarios`,
    "",
    "## Scenarios",
    ...lines,
    "",
    "## Versioned routes",
    "- POST /v1/tenants/{tenantId}/users/{userId}/conversations/{conversationId}/turn",
    "- GET /v1/tenants/{tenantId}/users/{userId}/conversations/{conversationId}/events",
    "- POST /v1/tenants/{tenantId}/users/{userId}/sandbox/file-edit",
  ].join("\n");
}
