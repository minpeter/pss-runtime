import {
  conversationPathParameters,
  getJson,
  getText,
  identityQueryParameters,
  jsonRequest,
  jsonResponse,
  pathParameter,
  responseMap,
} from "./openapi-helpers";
import {
  eventResultSchema,
  genericObjectSchema,
  type OpenApiObject,
  pathTurnRequestSchema,
  runEnvelopeSchema,
  runEventsSchema,
  sandboxFileEditRequestSchema,
  scenarioListSchema,
  turnRequestSchema,
} from "./openapi-schemas";

export function openApiDocument(baseUrl: string): OpenApiObject {
  return {
    info: { title: "pss-agent-worker", version: "0.1.0" },
    openapi: "3.1.0",
    paths: {
      "/docs/index.md": getText("Read Markdown docs for agents."),
      "/events": getJson(
        "Read the latest legacy conversation result.",
        eventResultSchema,
        identityQueryParameters()
      ),
      "/health": getJson("Read public Worker health.", genericObjectSchema),
      "/llms.txt": getText("Read the agent-facing Markdown index."),
      "/openapi.json": getJson(
        "Read this OpenAPI document.",
        genericObjectSchema
      ),
      "/runs": {
        post: {
          description: "Create a deterministic Cloudflare stress run.",
          requestBody: jsonRequest(turnRequestSchema),
          responses: responseMap({
            "201": jsonResponse("Completed run envelope.", runEnvelopeSchema),
          }),
        },
      },
      "/runs/{runId}": getJson(
        "Read a completed run envelope.",
        runEnvelopeSchema,
        [pathParameter("runId"), ...identityQueryParameters()]
      ),
      "/runs/{runId}/events": getJson(
        "Read bounded run events, markers, and evidence.",
        runEventsSchema,
        [pathParameter("runId"), ...identityQueryParameters()]
      ),
      "/scenarios": getJson(
        "List supported scenario metadata.",
        scenarioListSchema
      ),
      "/scenarios/{id}": getJson(
        "Read one scenario metadata entry.",
        genericObjectSchema,
        [pathParameter("id")]
      ),
      "/turn": {
        post: {
          description: "Run a legacy turn using identity from the body.",
          requestBody: jsonRequest(turnRequestSchema),
          responses: responseMap({
            "200": jsonResponse("Stress scenario result.", eventResultSchema),
          }),
        },
      },
      "/v1/tenants/{tenantId}/users/{userId}/conversations/{conversationId}/events":
        getJson(
          "Read the latest conversation turn result by path identity.",
          eventResultSchema,
          conversationPathParameters()
        ),
      "/v1/tenants/{tenantId}/users/{userId}/conversations/{conversationId}/turn":
        {
          post: {
            description:
              "Run a turn using tenant, user, and conversation identity from the path.",
            parameters: conversationPathParameters(),
            requestBody: jsonRequest(pathTurnRequestSchema),
            responses: responseMap({
              "200": jsonResponse("Stress scenario result.", eventResultSchema),
            }),
          },
        },
      "/v1/tenants/{tenantId}/users/{userId}/sandbox/file-edit": {
        post: {
          description:
            "Create or describe a user-scoped Cloudflare Sandbox SDK file edit flow.",
          parameters: [pathParameter("tenantId"), pathParameter("userId")],
          requestBody: jsonRequest(sandboxFileEditRequestSchema),
          responses: responseMap({
            "200": jsonResponse(
              "Sandbox file-edit demo result.",
              genericObjectSchema
            ),
          }),
        },
      },
    },
    servers: [{ url: baseUrl }],
  };
}
