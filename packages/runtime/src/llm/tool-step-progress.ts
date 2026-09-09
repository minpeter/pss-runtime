import type { ModelMessage } from "ai";
import { StoppedToolRecoveryError } from "./stopped-model-step";

interface Entry {
  readonly input: unknown;
  outcome?: { readonly value: string; readonly type: "text" | "error-text" };
  settled: boolean;
  readonly toolCallId: string;
  readonly toolName: string;
}

/** Request-local execution ledger, including hostless tools and SDK-detached work. */
export class ToolStepProgress {
  readonly #entries: Entry[] = [];
  #authorityFailed = false;
  #recoveryError: unknown;

  get authorityFailed(): boolean {
    return this.#authorityFailed;
  }
  markAuthorityFailure(): void {
    this.#authorityFailed = true;
  }
  get recoveryError(): unknown {
    return this.#recoveryError;
  }
  recordRecoveryError(error: unknown): void {
    this.#recoveryError = error;
  }

  begin(input: unknown, toolCallId: string, toolName: string) {
    const entry: Entry = { input, toolCallId, toolName, settled: false };
    this.#entries.push(entry);
    return {
      complete: (output: unknown) => {
        entry.outcome = {
          type: "text",
          value:
            typeof output === "string"
              ? output
              : (JSON.stringify(output) ?? "undefined"),
        };
        entry.settled = true;
      },
      failed: (error: unknown, recoverable: boolean) => {
        if (recoverable) {
          entry.outcome = {
            type: "error-text",
            value: error instanceof Error ? error.message : String(error),
          };
          entry.settled = true;
        }
      },
    };
  }

  get hasUnresolved(): boolean {
    return this.#entries.some((entry) => !entry.settled);
  }

  recover(): ModelMessage[] {
    if (this.hasUnresolved) {
      throw new StoppedToolRecoveryError(() => this.recover());
    }
    return this.#entries.flatMap((entry): ModelMessage[] =>
      entry.outcome
        ? [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: entry.toolCallId,
                  toolName: entry.toolName,
                  input: entry.input,
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: entry.toolCallId,
                  toolName: entry.toolName,
                  output: entry.outcome,
                },
              ],
            },
          ]
        : []
    );
  }
}
