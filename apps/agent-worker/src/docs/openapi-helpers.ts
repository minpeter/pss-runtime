import {
  errorSchema,
  type OpenApiObject,
  routeTokenSchema,
  stringSchema,
} from "./openapi-schemas";

export function getJson(
  description: string,
  schema: OpenApiObject,
  parameters?: readonly OpenApiObject[]
): OpenApiObject {
  return {
    get: {
      description,
      parameters,
      responses: responseMap({ "200": jsonResponse(description, schema) }),
    },
  };
}

export function getText(description: string): OpenApiObject {
  return {
    get: {
      description,
      responses: responseMap({
        "200": {
          content: { "text/plain": { schema: stringSchema } },
          description,
        },
      }),
    },
  };
}

export function jsonRequest(schema: OpenApiObject): OpenApiObject {
  return {
    content: { "application/json": { schema } },
    required: true,
  };
}

export function jsonResponse(
  description: string,
  schema: OpenApiObject
): OpenApiObject {
  return {
    content: { "application/json": { schema } },
    description,
  };
}

export function responseMap(responses: OpenApiObject): OpenApiObject {
  return {
    ...responses,
    "400": jsonResponse("Invalid request.", errorSchema),
    "401": jsonResponse("Unauthorized.", errorSchema),
    "413": jsonResponse("Request body too large.", errorSchema),
    "431": jsonResponse("Request headers too large.", errorSchema),
  };
}

export function conversationPathParameters(): readonly OpenApiObject[] {
  return [
    pathParameter("tenantId"),
    pathParameter("userId"),
    pathParameter("conversationId"),
  ];
}

export function identityQueryParameters(): readonly OpenApiObject[] {
  return [
    queryParameter("tenant", "Tenant id."),
    queryParameter("user", "User id."),
    queryParameter("conversation", "Conversation id."),
  ];
}

export function pathParameter(name: string): OpenApiObject {
  return {
    in: "path",
    name,
    required: true,
    schema: routeTokenSchema,
  };
}

function queryParameter(name: string, description: string): OpenApiObject {
  return {
    description,
    in: "query",
    name,
    required: true,
    schema: routeTokenSchema,
  };
}
