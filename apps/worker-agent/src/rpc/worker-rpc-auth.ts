import { type Env, isDevelopment } from "../env";

export function isAuthorizedWorkerRequest(request: Request, env: Env): boolean {
  const token = env.WORKER_AGENT_TUI_TOKEN?.trim();
  if (!token) {
    return isDevelopment(env);
  }

  return request.headers.get("authorization") === `Bearer ${token}`;
}
