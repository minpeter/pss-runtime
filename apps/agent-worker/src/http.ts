import type { TurnRequest } from "./request-schema";
import { appBudgets, parseTurnBody, totalHeaderBytes } from "./request-schema";

export type TurnRequestReadResult =
  | { readonly ok: true; readonly value: TurnRequest }
  | {
      readonly error: string;
      readonly ok: false;
      readonly status: 400 | 413 | 431;
    };

interface BoundedJsonRequest {
  readonly headers: Headers;
  text(): Promise<string>;
}

export async function readTurnRequest(
  request: BoundedJsonRequest
): Promise<TurnRequestReadResult> {
  const headersBytes = totalHeaderBytes(request.headers);
  if (headersBytes > appBudgets.maxHeaderBytes) {
    return {
      error: "request headers exceed the agent-worker header budget",
      ok: false,
      status: 431,
    };
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > appBudgets.maxBodyBytes) {
    return {
      error: "request body exceeds the agent-worker body budget",
      ok: false,
      status: 413,
    };
  }

  const parsedJson = parseJson(text);
  if (!parsedJson.ok) {
    return parsedJson;
  }

  return parseTurnBody(parsedJson.value);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function parseJson(
  text: string
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly error: string; readonly ok: false; readonly status: 400 } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        error: "request body must be valid JSON",
        ok: false,
        status: 400,
      };
    }
    throw error;
  }
}
