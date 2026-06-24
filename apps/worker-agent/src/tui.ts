import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { argv, env, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { AgentHost, ThreadInspection } from "@minpeter/pss-runtime";
import { createNodeFileThreadHost } from "@minpeter/pss-runtime/node";
import { z } from "zod";

import { createConfiguredAgent, type WorkerAgentModelEnv } from "./agent";
import type { WorkerAgentDeliveryResponse } from "./agent-do";
import { type ChannelAddress, channelKey } from "./channel";
import { deliverTuiInspect, isTuiInspectCommand } from "./tui-inspect";
import { createRemoteTuiDeliveryClient } from "./tui-remote";
import {
  createTuiMessageSink,
  deliverRemoteTuiTurn,
  deliverTuiTurn,
  type TuiOutput,
  WORKER_AGENT_TUI_CHANNEL,
} from "./tui-sink";

const TuiEnvironmentSchema = z
  .object({
    AI_API_KEY: z.string().optional(),
    AI_BASE_URL: z.string().optional(),
    AI_MODEL: z.string().optional(),
    WORKER_AGENT_TUI_CHANNEL_ID: z.string().optional(),
    WORKER_AGENT_TUI_DIR: z.string().optional(),
    WORKER_AGENT_TUI_ENDPOINT: z.string().url().optional(),
    WORKER_AGENT_TUI_TOKEN: z.string().optional(),
  })
  .passthrough();

export type WorkerAgentTuiConfig =
  | WorkerAgentLocalTuiConfig
  | WorkerAgentRemoteTuiConfig;

export interface WorkerAgentLocalTuiConfig {
  readonly channel: ChannelAddress;
  readonly directory: string;
  readonly env: WorkerAgentModelEnv;
  readonly mode: "local";
}

export interface WorkerAgentRemoteTuiConfig {
  readonly channel: ChannelAddress;
  readonly endpoint: string;
  readonly mode: "remote";
  readonly token?: string;
}

export interface StartWorkerAgentTuiOptions {
  readonly config?: WorkerAgentTuiConfig;
  readonly host?: AgentHost;
  readonly output?: TuiOutput;
}

export function resolveWorkerAgentTuiConfig(
  environment: NodeJS.ProcessEnv = env,
  args: readonly string[] = argv.slice(2)
): WorkerAgentTuiConfig {
  const parsed = TuiEnvironmentSchema.parse(environment);
  const remoteEndpoint = readRemoteEndpoint(
    parsed.WORKER_AGENT_TUI_ENDPOINT,
    args
  );
  const channel = {
    id:
      parsed.WORKER_AGENT_TUI_CHANNEL_ID?.trim() || WORKER_AGENT_TUI_CHANNEL.id,
    kind: "tui",
  } satisfies ChannelAddress;

  if (remoteEndpoint) {
    return {
      channel,
      endpoint: remoteEndpoint,
      mode: "remote",
      ...(parsed.WORKER_AGENT_TUI_TOKEN?.trim()
        ? { token: parsed.WORKER_AGENT_TUI_TOKEN.trim() }
        : {}),
    };
  }

  const apiKey = parsed.AI_API_KEY?.trim();
  if (!apiKey) {
    throw new WorkerAgentTuiConfigError(
      "AI_API_KEY is required for local TUI mode. Set WORKER_AGENT_TUI_ENDPOINT or pass --remote for remote mode."
    );
  }

  return {
    channel,
    directory:
      parsed.WORKER_AGENT_TUI_DIR?.trim() ||
      join(homedir(), ".pss-next", "worker-agent-tui"),
    env: {
      AI_API_KEY: apiKey,
      ENVIRONMENT: "development",
      ...(parsed.AI_BASE_URL?.trim()
        ? { AI_BASE_URL: parsed.AI_BASE_URL.trim() }
        : {}),
      ...(parsed.AI_MODEL?.trim() ? { AI_MODEL: parsed.AI_MODEL.trim() } : {}),
    },
    mode: "local",
  };
}

export async function startWorkerAgentTui(
  options: StartWorkerAgentTuiOptions = {}
): Promise<void> {
  const config = options.config ?? resolveWorkerAgentTuiConfig();
  const output =
    options.output ??
    ({
      writeLine: (line) => stdout.write(`${line}\n`),
    } satisfies TuiOutput);

  const input = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  let inputClosed = false;
  input.once("close", () => {
    inputClosed = true;
  });
  const close = await configureTuiTurnDelivery(config, output, options.host);

  output.writeLine("pss worker-agent TUI. Type /exit to quit.");
  input.setPrompt("> ");
  input.prompt();

  for await (const line of input) {
    const text = line.trim();
    if (text === "/exit" || text === "/quit") {
      break;
    }

    if (isTuiInspectCommand(text)) {
      if (close.inspect) {
        await deliverTuiInspect({
          defaultKey: channelKey(config.channel),
          inspect: close.inspect,
          output,
          text,
        });
      } else {
        output.writeLine("inspect is only available in local TUI mode.");
      }
      if (!inputClosed) {
        input.prompt();
      }
      continue;
    }

    await close.deliver(text);
    if (!inputClosed) {
      input.prompt();
    }
  }

  if (!inputClosed) {
    input.close();
  }
  await close.dispose();
}

async function configureTuiTurnDelivery(
  config: WorkerAgentTuiConfig,
  output: TuiOutput,
  hostOverride?: AgentHost
): Promise<{
  readonly deliver: (text: string) => Promise<WorkerAgentDeliveryResponse>;
  readonly dispose: () => Promise<void>;
  readonly inspect?: (key: string) => Promise<ThreadInspection>;
}> {
  switch (config.mode) {
    case "local": {
      await mkdir(config.directory, { recursive: true });
      const host =
        hostOverride ??
        createNodeFileThreadHost({ directory: config.directory });
      const agent = createConfiguredAgent(config.env, host, {
        sendMessage: {
          channel: () => config.channel,
          sink: createTuiMessageSink(output),
        },
      });
      const thread = agent.thread(channelKey(config.channel));
      return {
        deliver: (text) =>
          deliverTuiTurn({
            output,
            text,
            thread,
          }),
        dispose: () => thread.dispose(),
        inspect: (key) => agent.inspectThread(key),
      };
    }
    case "remote": {
      const client = createRemoteTuiDeliveryClient(config);
      return {
        deliver: (text) =>
          deliverRemoteTuiTurn({
            client,
            output,
            text,
          }),
        dispose: () => Promise.resolve(),
        inspect: (key) => client.inspect(key),
      };
    }
    default:
      return assertNever(config);
  }
}

function readRemoteEndpoint(
  environmentValue: string | undefined,
  args: readonly string[]
): string | undefined {
  const flagValue = args.find((arg) => arg.startsWith("--remote="));
  if (flagValue) {
    return flagValue.slice("--remote=".length).trim();
  }

  const remoteFlagIndex = args.indexOf("--remote");
  const remoteArgValue =
    remoteFlagIndex >= 0 ? args[remoteFlagIndex + 1]?.trim() : undefined;
  return remoteArgValue || environmentValue?.trim();
}

function isMainModule(moduleUrl: string, argvPath = argv[1]): boolean {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}

if (isMainModule(import.meta.url)) {
  await startWorkerAgentTui();
}

function assertNever(value: never): never {
  throw new WorkerAgentTuiConfigError(
    `Unexpected TUI config variant: ${String(value)}`
  );
}

export class WorkerAgentTuiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerAgentTuiConfigError";
  }
}
