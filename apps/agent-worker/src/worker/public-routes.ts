import {
  docsIndexMarkdown,
  findScenarioCatalogEntry,
  llmsText,
  scenarioCatalog,
} from "../docs/catalog";
import { openApiDocument } from "../docs/openapi";
import { jsonResponse, textResponse } from "../request/http";
import { createHealthPayload } from "../scenarios";

export function publicWorkerResponse(
  request: Request,
  options: { readonly bindingPresent: boolean }
): Response | undefined {
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;
  if (url.pathname === "/health") {
    return jsonResponse(createHealthPayload(options));
  }
  if (url.pathname === "/llms.txt") {
    return textResponse(llmsText(baseUrl));
  }
  if (url.pathname === "/docs/index.md") {
    return textResponse(
      docsIndexMarkdown(baseUrl),
      "text/markdown; charset=utf-8"
    );
  }
  if (url.pathname === "/openapi.json") {
    return jsonResponse(openApiDocument(baseUrl));
  }
  if (url.pathname === "/scenarios") {
    return jsonResponse({ scenarios: scenarioCatalog });
  }

  const scenarioId = scenarioIdFromPath(url.pathname);
  if (!scenarioId) {
    return;
  }
  const scenario = findScenarioCatalogEntry(scenarioId);
  return scenario
    ? jsonResponse(scenario)
    : jsonResponse({ error: "scenario not found" }, 404);
}

function scenarioIdFromPath(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const [resource, id, extra] = segments;
  if (resource !== "scenarios" || !id || extra) {
    return;
  }
  return id;
}
