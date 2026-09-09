import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { ZodError } from "zod";

import type { Env } from "../env";
import {
  ReplayEventsRequestSchema,
  SubmitTurnRequestSchema,
} from "../session/session-contract";
import {
  dispatchSessionEventReplay,
  dispatchSessionSubmitTurn,
} from "../session/session-server";
import { TuiTurnInputSchema, TuiTurnOutputSchema } from "../tui/tui-contract";
import { dispatchTuiTurn } from "../tui/tui-server";
import {
  WorkerServerBadRequestError,
  WorkerServerUpstreamError,
} from "./server-errors";
import { isAuthorizedWorkerRequest } from "./worker-rpc-auth";

const WORKER_RPC_ENDPOINT = "/trpc";
const UNAUTHORIZED_MESSAGE = "unauthorized";

interface WorkerRpcContext {
  readonly env: Env;
  readonly request: Request;
}

const trpc = initTRPC.context<WorkerRpcContext>().create({
  errorFormatter({ error, shape }) {
    // An unknown procedure echoes the attacker-controlled URL path verbatim
    // (both in the message and in data.path), so an unauthenticated 404 body
    // grows without bound (a 2000-char path yields a 4000+ byte envelope).
    // Replace it with a fixed literal message and strip data.path.
    if (error.code === "NOT_FOUND") {
      const { path: _path, ...data } = shape.data;
      return { ...shape, data, message: "not found" };
    }
    // Schema-validation failures carry the raw zod issue dump as the
    // message; the dump echoes request-body key names (unrecognized_keys)
    // and grows with attacker-controlled input, so the envelope would be
    // neither bounded nor echo-free. Replace it with a fixed bounded
    // message. Procedural TRPCErrors already carry fixed literal messages
    // and pass through unchanged.
    if (error.cause instanceof ZodError) {
      return {
        ...shape,
        message:
          error.code === "BAD_REQUEST" ? "invalid request" : "internal error",
      };
    }
    // Transport errors can echo request headers or parser details. Keep
    // malformed requests bounded without changing internal error responses.
    if (
      error.code === "UNSUPPORTED_MEDIA_TYPE" ||
      (error.code === "BAD_REQUEST" && error.cause instanceof SyntaxError)
    ) {
      return { ...shape, message: "invalid request" };
    }
    return shape;
  },
  isDev: false,
});

const authorizedProcedure = trpc.procedure.use(({ ctx, next }) => {
  if (!isAuthorizedWorkerRequest(ctx.request, ctx.env)) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: UNAUTHORIZED_MESSAGE,
    });
  }

  return next();
});

export const workerAgentRouter = trpc.router({
  session: trpc.router({
    replayEvents: authorizedProcedure
      .input(ReplayEventsRequestSchema)
      .query(async ({ ctx, input }) =>
        translateServerErrors(() => dispatchSessionEventReplay(input, ctx.env))
      ),
    submitTurn: authorizedProcedure
      .input(SubmitTurnRequestSchema)
      .mutation(async ({ ctx, input }) =>
        translateServerErrors(() => dispatchSessionSubmitTurn(input, ctx.env))
      ),
  }),
  tui: trpc.router({
    turn: authorizedProcedure
      .input(TuiTurnInputSchema)
      .output(TuiTurnOutputSchema)
      .mutation(async ({ ctx, input }) =>
        translateServerErrors(() => dispatchTuiTurn(input, ctx.env))
      ),
  }),
});

export type WorkerAgentRouter = typeof workerAgentRouter;

export function handleWorkerRpcRequest(
  request: Request,
  env: Env
): Promise<Response> {
  return fetchRequestHandler({
    createContext: () => ({ env, request }),
    endpoint: WORKER_RPC_ENDPOINT,
    req: request,
    router: workerAgentRouter,
  });
}

async function translateServerErrors<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkerServerBadRequestError) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error.message,
      });
    }
    if (error instanceof WorkerServerUpstreamError) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: error.message,
      });
    }
    // Unknown failures must not leak internal messages (zod issues, syntax
    // errors, stub internals) into the client envelope: tRPC would otherwise
    // copy `cause.message` onto the INTERNAL_SERVER_ERROR shape.
    throw new TRPCError({
      cause: error,
      code: "INTERNAL_SERVER_ERROR",
      message: "internal error",
    });
  }
}
