import { runAgentLoop } from "../agent-loop";
import type { AgentHooks } from "../hooks";
import type { Llm } from "../llm";
import type {
  AgentEvent,
  RuntimeInput,
  UserMessage,
  UserMessageContentPart,
} from "./events";
import { ModelMessageHistory } from "./history";
import type { AgentInput, UserInput } from "./input";
import type { AgentRun } from "./run";
import { BufferedAgentRun } from "./run";
import { decodeStoredSessionSnapshot, encodeSessionSnapshot } from "./snapshot";
import type { SessionStore } from "./store/types";

export type { AgentInput, SessionInput, UserInput } from "./input";
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
const noBoundaryDecision = undefined;

interface QueuedRuntimeInput {
  readonly input: UserInput;
  readonly placement: RuntimeInputPlacement;
}

interface RuntimeInputState {
  closedReason?: string;
  pending: Promise<void>;
  placement?: RuntimeInputPlacement;
  readonly queue: QueuedRuntimeInput[];
  steerPlacement?: RuntimeInputPlacement;
}

export class AgentSession {
  readonly #hooks?: AgentHooks;
  readonly #inputQueue: QueuedInput[] = [];
  readonly #llm: Llm;
  readonly #pendingRuntimeInputs: QueuedRuntimeInput[] = [];
  readonly #persistence: SessionPersistenceOptions;
  #activeAbort?: AbortController;
  #activeRun?: BufferedAgentRun;
  #activeRuntimeInput?: RuntimeInputState;
  #history = new ModelMessageHistory();
  #killed = false;
  #loadPromise?: Promise<void>;
  #loaded = false;
  #running = false;
  #runToCloseOnKill?: BufferedAgentRun;
  #storeVersion: string | undefined;

  constructor(
    llm: Llm,
    persistence: SessionPersistenceOptions,
    hooks?: AgentHooks
  ) {
    this.#hooks = hooks;
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

    const runtimeInput: RuntimeInputState = {
      pending: Promise.resolve(),
      queue: this.#pendingRuntimeInputs.splice(0),
    };
    const acceptedInput = normalizeAgentInput(input);
    const run = new BufferedAgentRun();
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

  async steer(input: AgentInput): Promise<AgentRun> {
    if (this.#killed) {
      throw sessionKilledError();
    }

    const runtimeInput = this.#activeRuntimeInput;
    const run = this.#activeRun;
    if (!(runtimeInput && run)) {
      return this.send(input);
    }

    await this.#addSteeringInput(runtimeInput, input);
    return run;
  }

  interrupt(): void {
    this.#activeAbort?.abort();
  }

  enqueueRuntimeInput(
    input: UserInput,
    placement: RuntimeInputPlacement = "turn-start"
  ): void {
    const runtimeInput = this.#activeRuntimeInput;
    if (runtimeInput && !runtimeInput.closedReason) {
      runtimeInput.queue.push({ input, placement });
      return;
    }

    this.#pendingRuntimeInputs.push({ input, placement });
  }

  emitObserverEvent(event: AgentEvent): void {
    this.#activeRun?.emit(event);
  }

  kill(): void {
    if (this.#killed) {
      return;
    }

    this.#killed = true;
    const killedError = sessionKilledError();
    this.#activeAbort?.abort();
    this.#closeRuntimeInput(this.#activeRuntimeInput, killedError.message);
    const runToClose = this.#runToCloseOnKill ?? this.#activeRun;
    runToClose?.emit({
      type: "turn-error",
      message: killedError.message,
    });
    runToClose?.close(undefined, killedError.message);

    while (this.#inputQueue.length > 0) {
      const item = this.#inputQueue.shift();
      this.#closeRuntimeInput(item?.runtimeInput, killedError.message);
      item?.run.emit({
        type: "turn-error",
        message: killedError.message,
      });
      item?.run.close(undefined, killedError.message);
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
    this.#history = new ModelMessageHistory(
      decodeStoredSessionSnapshot(stored)
    );
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
    const activeAbort = new AbortController();
    this.#activeAbort = activeAbort;
    this.#activeRun = run;
    this.#activeRuntimeInput = runtimeInput;
    this.#runToCloseOnKill = run;
    const historySnapshot = this.#history.modelSnapshot();

    try {
      await this.#withSteeringPlacement(
        runtimeInput,
        "turn-start",
        async () => {
          await this.#hooks?.beforeTurn?.({
            history: this.#history.modelSnapshot(),
            input,
            signal: activeAbort.signal,
          });
        }
      );
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
            return noBoundaryDecision;
          }

          run.emit(event);
        },
        history: this.#history,
        hooks: this.#hooksForRuntimeInput(runtimeInput),
        llm: this.#llm,
        signal: activeAbort.signal,
      });

      await this.#commitHistory();
      const terminalEvent = result === "aborted" ? "turn-abort" : "turn-end";
      this.#closeRuntimeInput(runtimeInput, terminalEvent);
      this.#activeRuntimeInput = undefined;
      this.#activeRun = undefined;
      await runAfterTurnHook(this.#hooks, {
        history: this.#history.modelSnapshot(),
        input,
        result,
        signal: activeAbort.signal,
      });
      run.emit({ type: terminalEvent });
    } catch (error) {
      if (error instanceof SessionCommitConflictError) {
        run.emit({ type: "turn-error", message: error.message });
        this.#closeRuntimeInput(runtimeInput, "a session commit conflict");
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
        this.#closeRuntimeInput(runtimeInput, "turn-error");
        this.#activeAbort = undefined;
        return;
      }
      run.emit({ type: "turn-error", message: errorMessage(error) });
      this.#closeRuntimeInput(runtimeInput, "turn-error");
    } finally {
      this.#closeRuntimeInput(runtimeInput);
      this.#activeAbort = undefined;
      this.#activeRun = undefined;
      this.#activeRuntimeInput = undefined;
      this.#runToCloseOnKill = undefined;
      run.close(undefined, runtimeInput.closedReason);
    }
  }

  #addSteeringInput(
    runtimeInput: RuntimeInputState,
    input: AgentInput
  ): Promise<void> {
    const next = runtimeInput.pending.then(() => {
      if (runtimeInput.closedReason) {
        throw runtimeInputClosedError(runtimeInput.closedReason);
      }

      runtimeInput.queue.push({
        input: normalizeAgentInput(input),
        placement:
          runtimeInput.steerPlacement ?? runtimeInput.placement ?? "step-end",
      });
    });
    runtimeInput.pending = next.catch(() => undefined);
    return next;
  }

  #closeRuntimeInput(
    runtimeInput: RuntimeInputState | undefined,
    reason = "the run reached a terminal state"
  ): void {
    if (!runtimeInput?.closedReason && runtimeInput) {
      runtimeInput.closedReason = reason;
      runtimeInput.placement = undefined;
    }
  }

  async #commitHistory(): Promise<void> {
    const result = await this.#persistence.store.commit(
      this.#persistence.key,
      {
        state: encodeSessionSnapshot(this.#history.modelSnapshot()),
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
    const previousSteerPlacement = runtimeInput.steerPlacement;
    runtimeInput.placement = placement;
    runtimeInput.steerPlacement = placement;
    try {
      return await callback();
    } finally {
      runtimeInput.placement = undefined;
      runtimeInput.steerPlacement = previousSteerPlacement;
    }
  }

  async #withSteeringPlacement<T>(
    runtimeInput: RuntimeInputState,
    placement: RuntimeInputPlacement,
    callback: () => Promise<T>
  ): Promise<T> {
    const previousSteerPlacement = runtimeInput.steerPlacement;
    runtimeInput.steerPlacement = placement;
    try {
      return await callback();
    } finally {
      runtimeInput.steerPlacement = previousSteerPlacement;
    }
  }

  #hooksForRuntimeInput(
    runtimeInput: RuntimeInputState
  ): AgentHooks | undefined {
    const hooks = this.#hooks;
    if (!hooks) {
      return;
    }

    return {
      ...hooks,
      afterStep: (context) =>
        this.#withSteeringPlacement(runtimeInput, "step-end", async () => {
          await hooks.afterStep?.(context);
        }),
      beforeStep: (context) =>
        this.#withSteeringPlacement(runtimeInput, "step-start", async () => {
          await hooks.beforeStep?.(context);
        }),
    };
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
  const index = runtimeInput.queue.findIndex(
    (input) => input.placement === placement
  );
  if (index === -1) {
    return;
  }

  return runtimeInput.queue.splice(index, 1)[0];
}

async function runAfterTurnHook(
  hooks: AgentHooks | undefined,
  context: Parameters<NonNullable<AgentHooks["afterTurn"]>>[0]
): Promise<void> {
  const hook = hooks?.afterTurn;
  if (!hook) {
    return;
  }

  await Promise.allSettled([Promise.resolve().then(() => hook(context))]);
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

function runtimeInputClosedError(reason: string): Error {
  return new Error(`session.steer() cannot be used after ${reason}`);
}

class SessionCommitConflictError extends Error {
  constructor(key: string) {
    super(`Session ${JSON.stringify(key)} commit conflict`);
  }
}
