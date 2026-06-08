import { describe, expect, it } from "vitest";
import {
  docsIndexMarkdown,
  findScenarioCatalogEntry,
  llmsText,
  scenarioCatalog,
} from "./catalog";
import { openApiDocument } from "./openapi";

describe("agent worker docs catalog", () => {
  it("publishes agent-friendly scenario metadata", () => {
    expect(scenarioCatalog.map((entry) => entry.id)).toContain(
      "user-sandbox-file-edit"
    );
    expect(findScenarioCatalogEntry("long-running-pingpong")).toMatchObject({
      id: "long-running-pingpong",
      route: "POST /runs",
    });
  });

  it("renders llms.txt, markdown docs, and OpenAPI hints", () => {
    const baseUrl = "https://worker.example";
    const openapi = openApiDocument(baseUrl);

    expect(llmsText(baseUrl)).toContain("/docs/index.md");
    expect(docsIndexMarkdown(baseUrl)).toContain("user-sandbox-file-edit");
    expect(openapi).toMatchObject({
      info: { title: "pss-agent-worker" },
      openapi: "3.1.0",
    });
    expect(openapi).toMatchObject({
      paths: {
        "/runs": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      scenario: expect.any(Object),
                    },
                  },
                },
              },
            },
            responses: {
              "201": expect.any(Object),
              "400": expect.any(Object),
            },
          },
        },
        "/v1/tenants/{tenantId}/users/{userId}/sandbox/file-edit": {
          post: {
            parameters: [
              expect.objectContaining({ name: "tenantId" }),
              expect.objectContaining({ name: "userId" }),
            ],
            requestBody: expect.any(Object),
            responses: {
              "200": expect.any(Object),
              "401": expect.any(Object),
            },
          },
        },
      },
    });
  });
});
