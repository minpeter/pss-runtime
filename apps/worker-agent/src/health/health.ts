import type { Env } from "../env";

const HEALTH_PATHNAME = "/healthz";

const JSON_CONTENT_TYPE = "application/json";
const ALLOW_GET = "GET";

/** Minimal structured-log sink so failure detail stays out of the HTTP body. */
export interface HealthRouteLog {
  set(fields: Record<string, unknown>): void;
}

/** Exact `/healthz` plus its trailing-slash variant; sub-paths are NOT health. */
export function isHealthPathname(pathname: string): boolean {
  return pathname === HEALTH_PATHNAME || pathname === `${HEALTH_PATHNAME}/`;
}

/**
 * Read-only liveness probe: no Durable Object fetches, no provider requests,
 * no Telegram calls, no auth. The success body is bounded (<1 KiB) and
 * deterministic for a fixed binding state; the failure body is a bounded
 * opaque `{"error":"unavailable"}` with detail only in structured logs.
 */
export function handleHealthRequest(
  request: Request,
  env: Env,
  log?: HealthRouteLog
): Response {
  if (request.method !== "GET") {
    return healthJsonResponse(
      405,
      { error: "method not allowed" },
      { allow: ALLOW_GET }
    );
  }

  const unavailableReasons = collectUnavailableReasons(env);
  if (unavailableReasons.length > 0) {
    log?.set({ health: "unavailable", healthReasons: unavailableReasons });
    return healthJsonResponse(503, { error: "unavailable" });
  }

  return healthJsonResponse(200, {
    environment: env.ENVIRONMENT,
    version: env.CF_VERSION_METADATA?.id ?? null,
    agentDo: true,
  });
}

function collectUnavailableReasons(env: Env): string[] {
  const reasons: string[] = [];

  if (env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "production") {
    reasons.push("environment-binding-invalid");
  }
  if (!hasAgentDoBinding(env.AGENT_DO)) {
    reasons.push("agent-do-binding-missing");
  }
  const metadata = env.CF_VERSION_METADATA;
  if (
    metadata !== undefined &&
    metadata !== null &&
    (typeof metadata.id !== "string" || metadata.id.length === 0)
  ) {
    reasons.push("version-metadata-binding-invalid");
  }

  return reasons;
}

/** Presence only: the namespace exists and exposes get(); it is never called. */
function hasAgentDoBinding(namespace: Env["AGENT_DO"]): boolean {
  return (
    typeof namespace === "object" &&
    namespace !== null &&
    typeof namespace.get === "function"
  );
}

function healthJsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      ...headers,
    },
  });
}
