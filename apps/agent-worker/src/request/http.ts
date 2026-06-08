import type { TurnRequest } from "./schema";
import { appBudgets, parseTurnBody, totalHeaderBytes } from "./schema";

const contentLengthPattern = /^\d+$/;

export type TurnRequestReadResult =
  | { readonly ok: true; readonly value: TurnRequest }
  | {
      readonly error: string;
      readonly ok: false;
      readonly status: 400 | 413 | 431;
    };

interface BoundedJsonRequest {
  readonly body?: ReadableStream<Uint8Array> | null;
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
  if (declaredBodyExceedsBudget(request.headers)) {
    return bodyBudgetError();
  }

  const textResult = await readBoundedText(request);
  if (!textResult.ok) {
    return textResult;
  }

  const parsedJson = parseJson(textResult.value);
  if (!parsedJson.ok) {
    return parsedJson;
  }

  return parseTurnBody(parsedJson.value);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function declaredBodyExceedsBudget(headers: Headers): boolean {
  const contentLength = headers.get("content-length");
  if (!contentLength) {
    return false;
  }
  const trimmed = contentLength.trim();
  if (!contentLengthPattern.test(trimmed)) {
    return false;
  }
  return Number(trimmed) > appBudgets.maxBodyBytes;
}

async function readBoundedText(
  request: BoundedJsonRequest
): Promise<
  | { readonly ok: true; readonly value: string }
  | { readonly error: string; readonly ok: false; readonly status: 413 }
> {
  if (!request.body) {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > appBudgets.maxBodyBytes) {
      return bodyBudgetError();
    }
    return { ok: true, value: text };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > appBudgets.maxBodyBytes) {
        await reader.cancel();
        return bodyBudgetError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  return { ok: true, value: decodeChunks(chunks, totalBytes) };
}

function decodeChunks(
  chunks: readonly Uint8Array[],
  totalBytes: number
): string {
  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

function bodyBudgetError(): {
  readonly error: string;
  readonly ok: false;
  readonly status: 413;
} {
  return {
    error: "request body exceeds the agent-worker body budget",
    ok: false,
    status: 413,
  };
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
