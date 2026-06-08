import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import type { Env } from "./index";
import baseWorker, {
  AgentDurableObject as BaseAgentDurableObject,
} from "./index";

export class Sandbox extends CloudflareSandbox {}

export class AgentDurableObject extends BaseAgentDurableObject {}

const sandboxWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await baseWorker.fetch(request, env);
  },
};

export default sandboxWorker;
