import type { ModelMessage, UserModelMessage } from "ai";
import type { OverlayInputSummary, OverlayPlacement } from "./events";
import type { AgentInput, UserInput, UserMessageContentPart } from "./input";
import { userInputToModelMessage } from "./mapping";
import { normalizeAgentInput } from "./runtime-input";

export type OverlayPhase = "post-inference" | "pre-inference";

export interface OverlayEntry {
  readonly id: string;
  readonly input: UserInput;
  readonly message: UserModelMessage;
  readonly placement: OverlayPlacement;
  readonly summary: OverlayInputSummary;
}

export interface InferenceFrame {
  readonly postInferenceContext: OverlayEntry[];
  readonly preInferenceContext: OverlayEntry[];
}

export interface OverlayExpiredEvent {
  readonly count: number;
  readonly reason: "kill" | "turn-abort" | "turn-end" | "turn-error";
  readonly type: "overlay-expired";
}

let overlayCounter = 0;

export class SessionOverlayState {
  #activeFrame?: InferenceFrame;
  #activeInferenceStarted = false;
  #activeStepEndOverlayInputAdded = false;
  #activeTurnMessage?: ModelMessage;
  #pendingEntries: OverlayEntry[] = [];

  appendActiveOverlay(
    input: AgentInput,
    placement: OverlayPlacement
  ): OverlayEntry | undefined {
    const activeFrame = this.#activeFrame;
    if (!activeFrame) {
      return;
    }

    const entry = appendOverlay(
      activeFrame,
      input,
      placement,
      this.#activeInferenceStarted ? "post-inference" : "pre-inference"
    );
    if (entry.placement === "step-end") {
      this.#activeStepEndOverlayInputAdded = true;
    }
    return entry;
  }

  appendPendingOverlay(input: AgentInput): OverlayEntry {
    const frame = createInferenceFrame(this.#pendingEntries);
    const entry = appendOverlay(frame, input, "idle", "pre-inference");
    this.#pendingEntries = cloneOverlayEntries(frame.preInferenceContext);
    return entry;
  }

  compose(history: readonly ModelMessage[]): ModelMessage[] {
    return composeOverlayHistory({
      currentTurnMessage: this.#activeTurnMessage,
      frame: this.#activeFrame,
      history,
    });
  }

  consumeStepEndOverlayInputAdded(): boolean {
    const added = this.#activeStepEndOverlayInputAdded;
    this.#activeStepEndOverlayInputAdded = false;
    return added;
  }

  expireActiveFrame(
    reason: OverlayExpiredEvent["reason"]
  ): OverlayExpiredEvent | undefined {
    const count = frameOverlayCount(this.#activeFrame);
    if (count === 0) {
      return;
    }

    this.#activeFrame = undefined;
    return { count, reason, type: "overlay-expired" };
  }

  markInferenceStarted(): void {
    this.#activeInferenceStarted = true;
  }

  resetActiveTurn(): void {
    this.#activeFrame = undefined;
    this.#activeInferenceStarted = false;
    this.#activeStepEndOverlayInputAdded = false;
    this.#activeTurnMessage = undefined;
  }

  startTurn(input: UserInput): void {
    this.#activeFrame = createInferenceFrame(this.#pendingEntries);
    this.#activeInferenceStarted = false;
    this.#activeStepEndOverlayInputAdded = false;
    this.#activeTurnMessage = userInputToModelMessage(input);
    this.#pendingEntries = [];
  }
}

export function createInferenceFrame(
  preInferenceContext: readonly OverlayEntry[] = []
): InferenceFrame {
  return {
    postInferenceContext: [],
    preInferenceContext: structuredClone([...preInferenceContext]),
  };
}

export function appendOverlay(
  frame: InferenceFrame,
  input: AgentInput,
  placement: OverlayPlacement,
  phase: OverlayPhase
): OverlayEntry {
  const normalized = normalizeAgentInput(input);
  const entry = {
    id: `overlay-${++overlayCounter}`,
    input: structuredClone(normalized),
    message: userInputToModelMessage(normalized),
    placement,
    summary: summarizeOverlayInput(normalized),
  };

  if (phase === "pre-inference") {
    frame.preInferenceContext.push(entry);
    return entry;
  }

  frame.postInferenceContext.push(entry);
  return entry;
}

export function composeOverlayHistory({
  currentTurnMessage,
  frame,
  history,
}: {
  readonly currentTurnMessage?: ModelMessage;
  readonly frame?: InferenceFrame;
  readonly history: readonly ModelMessage[];
}): ModelMessage[] {
  if (
    !frame ||
    (frame.preInferenceContext.length === 0 &&
      frame.postInferenceContext.length === 0)
  ) {
    return structuredClone([...history]);
  }

  const snapshot = structuredClone([...history]);
  const pre = frame.preInferenceContext.map((entry) => entry.message);
  const post = frame.postInferenceContext.map((entry) => entry.message);
  const currentTurnIndex = findCurrentTurnIndex(snapshot, currentTurnMessage);

  if (currentTurnIndex === -1) {
    return [...snapshot, ...structuredClone(pre), ...structuredClone(post)];
  }

  return [
    ...snapshot.slice(0, currentTurnIndex),
    ...structuredClone(pre),
    ...snapshot.slice(currentTurnIndex),
    ...structuredClone(post),
  ];
}

export function frameOverlayCount(frame: InferenceFrame | undefined): number {
  return frame
    ? frame.preInferenceContext.length + frame.postInferenceContext.length
    : 0;
}

export function cloneOverlayEntries(
  entries: readonly OverlayEntry[]
): OverlayEntry[] {
  return structuredClone([...entries]);
}

function findCurrentTurnIndex(
  history: readonly ModelMessage[],
  currentTurnMessage: ModelMessage | undefined
): number {
  if (!currentTurnMessage) {
    return -1;
  }

  const target = JSON.stringify(currentTurnMessage);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (JSON.stringify(history[index]) === target) {
      return index;
    }
  }

  return -1;
}

function summarizeOverlayInput(input: UserInput): OverlayInputSummary {
  if (input.type === "user-text") {
    const text =
      typeof input.text === "string" ? input.text : input.text.join("\n");
    return {
      preview: previewText(text),
      textLength: text.length,
      type: "user-text",
    };
  }

  const text = input.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return {
    partCount: input.content.length,
    preview: text ? previewText(text) : summarizeNonTextParts(input.content),
    textLength: text.length,
    type: "user-message",
  };
}

function summarizeNonTextParts(
  parts: readonly UserMessageContentPart[]
): string {
  const kinds = parts.map((part) => part.type);
  return kinds.length === 0 ? "(empty message)" : kinds.join(", ");
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 80) {
    return normalized;
  }

  return `${normalized.slice(0, 80)}...`;
}
