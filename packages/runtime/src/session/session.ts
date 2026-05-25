import { runAgentLoop } from "../agent-loop";
import type { Llm } from "../llm";
import type {
  RuntimeInput,
  UserMessage,
  UserMessageContentPart,
  UserText,
} from "./events";
import { AgentModelHistory } from "./history";
import type { AgentRun } from "./run";
import { BufferedAgentRun } from "./run";
import { decodeStoredSessionSnapshot, encodeSessionSnapshot } from "./snapshot";
import type { SessionStore } from "./store/types";

export type UserInput = UserMessage | UserText;
export type AgentInput =
  | readonly string[]
  | readonly UserMessageContentPart[]
  | string
  | UserInput;
export type SessionInput = AgentInput;
export type { AgentRun } from "./run";

interface SessionPersistenceOptions {
  readonly key: string;
  readonly store: SessionStore;
}

interface QueuedInput {
  readonly input: UserInput;
  readonly run: BufferedAgentRun;
  readonly runtimeInput: RuntimeInputState;
}

type RuntimeInputPlacement = RuntimeInput["placement"];

interface QueuedRuntimeInput {
  readonly input: UserInput;
  readonly placement: RuntimeInputPlacement;
}

interface RuntimeInputState {
  placement?: RuntimeInputPlacement;
  readonly queue: QueuedRuntimeInput[];
}

export class AgentSession {
  readonly #inputQueue: QueuedInput[] = [];
  readonly #llm: Llm;
  readonly #persistence: SessionPersistenceOptions;
  #activeAbort?: AbortController;
  #history = new AgentModelHistory();
  #killed = false;
  #loadPromise?: Promise<void>;
  #loaded = false;
  #running = false;
  #storeVersion: string | undefined;

  constructor(llm: Llm, persistence: SessionPersistenceOptions) {
    this.#llm = llm;
    this.#persistence = persistence;
  }

  async send(input: AgentInput): Promise<AgentRun> {
    if (this.#killed) {
      throw sessionKilledError();
    }

    await this.#ensureLoaded();

    if (this.#killed) {
      throw sessionKilledError();
    }

    const runtimeInput: RuntimeInputState = { queue: [] };
    const acceptedInput = normalizeAgentInput(input);
    const run = new BufferedAgentRun({
      addInput: (input) => {
        if (!runtimeInput.placement) {
          throw new Error(
            "AgentRun.input.add() can only be used during an active run input window"
          );
        }

        runtimeInput.queue.push({
          input: normalizeAgentInput(input),
          placement: runtimeInput.placement,
        });
      },
    });
    run.emit(acceptedInput);
    this.#inputQueue.push({
      input: structuredClone(acceptedInput),
      run,
      runtimeInput,
    });
    this.#drainInputQueue().catch((error: unknown) => {
      run.emit({ type: "turn-error", message: errorMessage(error) });
      run.close();
    });
    return run;
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  kill(): void {
    if (this.#killed) {
      return;
    }

    this.#killed = true;
    this.#activeAbort?.abort();

    while (this.#inputQueue.length > 0) {
      const item = this.#inputQueue.shift();
      item?.run.emit({
        type: "turn-error",
        message: sessionKilledError().message,
      });
      item?.run.close();
    }
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    this.#loadPromise ??= this.#loadSessionState();
    try {
      await this.#loadPromise;
    } catch (error) {
      this.#loadPromise = undefined;
      throw error;
    }
  }

  async #loadSessionState(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    await this.#replaceWithStoredSession();
    this.#loaded = true;
  }

  async #replaceWithStoredSession(): Promise<void> {
    const stored = await this.#persistence.store.load(this.#persistence.key);
    this.#storeVersion = stored?.version;
    this.#history = new AgentModelHistory(decodeStoredSessionSnapshot(stored));
  }

  async #drainInputQueue(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;
    try {
      while (!this.#killed && this.#inputQueue.length > 0) {
        const item = this.#inputQueue.shift();
        if (item) {
          await this.#processQueuedInput(item);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  async #processQueuedInput({
    input,
    run,
    runtimeInput,
  }: QueuedInput): Promise<void> {
    this.#activeAbort = new AbortController();
    const historySnapshot = this.#history.modelSnapshot();

    try {
      await this.#withRuntimeInputWindow(
        runtimeInput,
        "turn-start",
        async () => {
          await run.emitBoundary({ type: "turn-start" });
        }
      );
      this.#history.appendUserInput(input);
      await this.#commitHistory();
      await this.#drainRuntimeInput(run, runtimeInput, "turn-start");

      const result = await runAgentLoop({
        emit: async (event) => {
          if (event.type === "step-start" || event.type === "step-end") {
            await this.#withRuntimeInputWindow(
              runtimeInput,
              event.type,
              async () => {
                await run.emitBoundary(event);
              }
            );
            const runtimeInputAdded = await this.#drainRuntimeInput(
              run,
              runtimeInput,
              event.type
            );

            if (event.type === "step-end") {
              return { runtimeInputAdded };
            }
            return;
          }

          run.emit(event);
        },
        history: this.#history,
        llm: this.#llm,
        signal: this.#activeAbort.signal,
      });

      await this.#commitHistory();
      run.emit({ type: result === "aborted" ? "turn-abort" : "turn-end" });
    } catch (error) {
      if (error instanceof SessionCommitConflictError) {
        run.emit({ type: "turn-error", message: error.message });
        this.#activeAbort = undefined;
        return;
      }

      this.#history.rollback(historySnapshot);
      try {
        await this.#commitHistory();
      } catch (rollbackError) {
        run.emit({
          type: "turn-error",
          message: `${errorMessage(error)}; history rollback persistence failed: ${errorMessage(
            rollbackError
          )}`,
        });
        this.#activeAbort = undefined;
        return;
      }
      run.emit({ type: "turn-error", message: errorMessage(error) });
    } finally {
      this.#activeAbort = undefined;
      run.close();
    }
  }

  async #commitHistory(): Promise<void> {
    const result = await this.#persistence.store.commit(
      this.#persistence.key,
      {
        state: encodeSessionSnapshot(this.#history.modelSnapshot()),
        version: this.#storeVersion,
      },
      { expectedVersion: this.#storeVersion ?? null }
    );

    if (!result.ok) {
      await this.#replaceWithStoredSession();
      throw new SessionCommitConflictError(this.#persistence.key);
    }

    this.#storeVersion = result.version;
  }

  async #withRuntimeInputWindow<T>(
    runtimeInput: RuntimeInputState,
    placement: RuntimeInputPlacement,
    callback: () => Promise<T>
  ): Promise<T> {
    runtimeInput.placement = placement;
    try {
      return await callback();
    } finally {
      runtimeInput.placement = undefined;
    }
  }

  async #drainRuntimeInput(
    run: BufferedAgentRun,
    runtimeInput: RuntimeInputState,
    placement: RuntimeInputPlacement
  ): Promise<boolean> {
    let added = false;
    let next = shiftRuntimeInput(runtimeInput, placement);
    while (next) {
      added = true;
      run.emit({ type: "runtime-input", input: next.input, placement });
      this.#history.appendUserInput(next.input);
      await this.#commitHistory();
      next = shiftRuntimeInput(runtimeInput, placement);
    }

    return added;
  }
}

function shiftRuntimeInput(
  runtimeInput: RuntimeInputState,
  placement: RuntimeInputPlacement
): QueuedRuntimeInput | undefined {
  const index = runtimeInput.queue.findIndex((input) => input.placement === placement);
  if (index === -1) {
    return undefined;
  }

  return runtimeInput.queue.splice(index, 1)[0];
}

export function normalizeAgentInput(input: AgentInput): UserInput {
  if (typeof input === "string") {
    return {
      type: "user-text",
      text: input,
    };
  }

  if (isStringArrayInput(input)) {
    return {
      type: "user-text",
      text: structuredClone(input) as readonly string[],
    };
  }

  if (isArrayInput(input)) {
    assertUserMessageContent(input);
    return {
      type: "user-message",
      content: structuredClone(input) as readonly UserMessageContentPart[],
    };
  }

  if (isUserMessage(input)) {
    assertUserMessageContent(input.content);
  }

  return structuredClone(input);
}

function isStringArrayInput(input: AgentInput): input is readonly string[] {
  return isArrayInput(input) && input.every((part) => typeof part === "string");
}

function isArrayInput(
  input: AgentInput
): input is readonly string[] | readonly UserMessageContentPart[] {
  return Array.isArray(input);
}

function isUserMessage(input: UserInput): input is UserMessage {
  return input.type === "user-message";
}

function assertUserMessageContent(
  input: readonly unknown[]
): asserts input is readonly UserMessageContentPart[] {
  for (const part of input) {
    if (!isUserMessageContentPart(part)) {
      throw new TypeError(
        'Agent input content parts must be { type: "text", text }, { type: "image", image }, or { type: "file", data, mediaType }.'
      );
    }
  }
}

function isUserMessageContentPart(
  part: unknown
): part is UserMessageContentPart {
  if (part === null || typeof part !== "object" || !("type" in part)) {
    return false;
  }

  if (part.type === "text") {
    return "text" in part && typeof part.text === "string";
  }

  if (part.type === "image") {
    return (
      "image" in part &&
      typeof part.image === "string" &&
      (!("mediaType" in part) || typeof part.mediaType === "string")
    );
  }

  if (part.type === "file") {
    return (
      "data" in part &&
      isUserMessageFileData(part.data) &&
      "mediaType" in part &&
      typeof part.mediaType === "string" &&
      (!("filename" in part) || typeof part.filename === "string")
    );
  }

  return false;
}

function isUserMessageFileData(data: unknown): boolean {
  if (typeof data === "string") {
    return true;
  }

  if (data === null || typeof data !== "object" || !("type" in data)) {
    return false;
  }

  if (data.type === "data") {
    return "data" in data && typeof data.data === "string";
  }

  if (data.type === "reference") {
    return (
      "reference" in data &&
      data.reference !== null &&
      typeof data.reference === "object" &&
      Object.values(data.reference).every((value) => typeof value === "string")
    );
  }

  if (data.type === "text") {
    return "text" in data && typeof data.text === "string";
  }

  if (data.type === "url") {
    return "url" in data && typeof data.url === "string";
  }

  return false;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sessionKilledError(): Error {
  return new Error("Session killed");
}

class SessionCommitConflictError extends Error {
  constructor(key: string) {
    super(`Session ${JSON.stringify(key)} commit conflict`);
  }
}
