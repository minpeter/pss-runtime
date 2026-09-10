import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { KernelExecutionError, QuickJsKernel } from "./kernel";
import { invokeTool, toolDefinitions } from "./tools";

interface Env {
  readonly KERNELS: DurableObjectNamespace<Kernel>;
}

type Json = z.infer<ReturnType<typeof z.json>>;
type ToolCall = {
  readonly sequence: number;
  readonly tool: string;
  readonly args: Json;
} & (
  | { readonly status: "pending" }
  | { readonly status: "ok"; readonly result: Json }
  | { readonly status: "error"; readonly error: string }
);

const evalInput = z.object({ code: z.string().min(1).max(16_000) }).strict();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Kernel extends DurableObject<Env> {
  #kernel: QuickJsKernel | undefined;
  #generation = crypto.randomUUID();
  #tail: Promise<void> = Promise.resolve();

  // DO requests can interleave across await; eval and reset must share one queue.
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    // The caller receives rejection; the queue's tail must still admit the next request.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async execute(code: string): Promise<string> {
    const outcome = await this.#enqueue(async () => {
      const executionId = crypto.randomUUID();
      const calls: ToolCall[] = [];
      try {
        this.#kernel ??= await QuickJsKernel.create();
        const result = await this.#kernel.execute(code, async (tool, rawArgs, signal) => {
          const args = z.json().parse(rawArgs);
          const index = calls.length;
          const base = { sequence: index + 1, tool, args };
          calls.push({ ...base, status: "pending" });
          try {
            const value = z.json().parse(await invokeTool(this.ctx.storage, tool, args, signal));
            calls[index] = {
              ...base,
              status: "ok",
              result: value,
            };
            return value;
          } catch (error) {
            calls[index] = {
              ...base,
              status: "error",
              error: errorMessage(error),
            };
            throw error;
          }
        });
        return {
          status: "ok",
          generation: this.#generation,
          executionId,
          result,
          calls,
        } as const;
      } catch (error) {
        this.#kernel?.dispose();
        this.#kernel = undefined;
        this.#generation = crypto.randomUUID();
        if (!(error instanceof KernelExecutionError)) throw error;
        return {
          status: "error",
          generation: this.#generation,
          executionId,
          error: { code: error.code, message: error.message },
          stateReset: true,
          calls,
        } as const;
      }
    });
    // A plain JSON value avoids live RPC streams and recursive RPC mapping of arbitrary JSON.
    return JSON.stringify(outcome);
  }

  reset() {
    return this.#enqueue(async () => {
      this.#kernel?.dispose();
      this.#kernel = undefined;
      this.#generation = crypto.randomUUID();
      return { status: "reset", generation: this.#generation } as const;
    });
  }
}

export default {
  // HTTP is the error-reporting boundary; unexpected failures are not guest execution errors.
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/") {
        return Response.json({
          name: "pss-kernel",
          description: "Container-free persistent QuickJS kernel PoC",
          endpoints: {
            health: "/health",
            tools: "/tools",
            eval: "/sessions/:id/eval",
            reset: "/sessions/:id/reset",
          },
        });
      }
      if (request.method === "GET" && path === "/health") {
        return Response.json({
          name: "pss-kernel",
          runtime: "durable-object/quickjs-wasm",
        });
      }
      if (request.method === "GET" && path === "/tools") {
        return Response.json({ tools: toolDefinitions });
      }
      const match = /^\/sessions\/([a-zA-Z0-9_-]{1,80})\/(eval|reset)$/.exec(path);
      const session = match?.[1];
      const action = match?.[2];
      if (!session) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          {
            status: 405,
          },
        );
      }
      const kernel = env.KERNELS.getByName(session);
      if (action === "reset") return Response.json(await kernel.reset());
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 32_000) {
        return Response.json(
          { error: "request_too_large" },
          {
            status: 413,
          },
        );
      }
      const { code } = evalInput.parse(JSON.parse(raw));
      return new Response(await kernel.execute(code), {
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return Response.json(
          {
            error: "invalid_request",
            message: error.message,
          },
          { status: 400 },
        );
      }
      console.error(error);
      return Response.json(
        { error: "internal_error", message: errorMessage(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
