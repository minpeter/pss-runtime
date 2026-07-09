/**
 * Node/vitest shim for the Cloudflare Agents SDK `Agent` class.
 * Real Workers load the official `agents` package.
 */
import { DurableObject } from "cloudflare:workers";

export class Agent<
  Env = Cloudflare.Env,
  State = unknown,
  // Props unused in tests but matches SDK generic shape.
  _Props extends Record<string, unknown> = Record<string, unknown>,
> extends DurableObject<Env> {
  initialState: State = undefined as State;

  onRequest(_request: Request): Promise<Response> {
    return Promise.resolve(new Response("not found", { status: 404 }));
  }

  /** PartyServer-compatible entry used by DO stubs and tests. */
  fetch(request: Request): Promise<Response> {
    return this.onRequest(request);
  }

  onFiberRecovered(
    _ctx: unknown
  ): Promise<undefined | { readonly status: string }> {
    return Promise.resolve(undefined);
  }

  schedule(
    _when: Date | number | string,
    _callback: string,
    payload: unknown
  ): Promise<{
    readonly callback: string;
    readonly id: string;
    readonly payload: unknown;
    readonly time: number;
    readonly type: "delayed";
    readonly delayInSeconds: number;
  }> {
    return Promise.resolve({
      callback: String(_callback),
      delayInSeconds: 0,
      id: "test-schedule",
      payload,
      time: Date.now(),
      type: "delayed",
    });
  }

  async startFiber(
    name: string,
    fn: (ctx: {
      readonly id: string;
      readonly signal: AbortSignal;
      readonly snapshot: unknown;
      stash(data: unknown): void;
    }) => Promise<void>,
    options?: { readonly idempotencyKey?: string }
  ): Promise<{
    readonly accepted: boolean;
    readonly createdAt: number;
    readonly fiberId: string;
    readonly idempotencyKey?: string;
    readonly name: string;
    readonly status: "completed";
  }> {
    const fiberId = `test-fiber-${name}`;
    await fn({
      id: fiberId,
      signal: new AbortController().signal,
      snapshot: null,
      stash: () => undefined,
    });
    return {
      accepted: true,
      createdAt: Date.now(),
      fiberId,
      idempotencyKey: options?.idempotencyKey,
      name,
      status: "completed",
    };
  }
}
