import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { type Env, isDevelopment } from "./env";
import { TuiTurnInputSchema, TuiTurnOutputSchema } from "./tui-contract";
import {
  dispatchTuiTurn,
  TuiServerBadRequestError,
  TuiServerUpstreamError,
} from "./tui-server";

const TUI_RPC_ENDPOINT = "/trpc";
const UNAUTHORIZED_MESSAGE = "unauthorized";

interface TuiRpcContext {
  readonly env: Env;
  readonly request: Request;
}

const trpc = initTRPC.context<TuiRpcContext>().create({ isDev: false });

const authorizedProcedure = trpc.procedure.use(({ ctx, next }) => {
  if (!isAuthorizedTuiRequest(ctx.request, ctx.env)) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: UNAUTHORIZED_MESSAGE,
    });
  }

  return next();
});

export const workerAgentRouter = trpc.router({
  tui: trpc.router({
    turn: authorizedProcedure
      .input(TuiTurnInputSchema)
      .output(TuiTurnOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await dispatchTuiTurn(input, ctx.env);
        } catch (error) {
          if (error instanceof TuiServerBadRequestError) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: error.message,
            });
          }
          if (error instanceof TuiServerUpstreamError) {
            throw new TRPCError({
              code: "BAD_GATEWAY",
              message: error.message,
            });
          }
          throw error;
        }
      }),
  }),
});

export type WorkerAgentRouter = typeof workerAgentRouter;

export function handleTuiRpcRequest(
  request: Request,
  env: Env
): Promise<Response> {
  return fetchRequestHandler({
    createContext: () => ({ env, request }),
    endpoint: TUI_RPC_ENDPOINT,
    req: request,
    router: workerAgentRouter,
  });
}

function isAuthorizedTuiRequest(request: Request, env: Env): boolean {
  const token = env.WORKER_AGENT_TUI_TOKEN?.trim();
  if (!token) {
    return isDevelopment(env);
  }

  return request.headers.get("authorization") === `Bearer ${token}`;
}
