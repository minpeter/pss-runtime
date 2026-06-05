import type { ModelMessage, UserModelMessage } from "ai";
import type { OverlayInputSummary, OverlayPlacement } from "./events";
import type { AgentInput, UserInput, UserMessageContentPart } from "./input";
import { userInputToModelMessage } from "./mapping";
import {
  type CurrentTurnAnchor,
  createCurrentTurnAnchor,
  resolveCurrentTurnIndex,
} from "./overlay-anchor";
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
  #activeTurn?: CurrentTurnAnchor;
  #pendingEntries: OverlayEntry[] = [];

  appendActiveOverlay(
    input: AgentInput,
    placement: OverlayPlacement
  ): OverlayEntry | undefined {
    const activeFrame = this.#activeFrame;
    if (!activeFrame) {
      return;
    }

    const phase = this.#activeInferenceStarted
      ? "post-inference"
      : "pre-inference";
    const entry = appendOverlay(activeFrame, input, placement, phase);
    if (entry.placement === "step-end" && phase === "post-inference") {
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

  compose(
    history: readonly ModelMessage[],
    canonicalHistory: readonly ModelMessage[]
  ): ModelMessage[] {
    return composeOverlayHistory({
      canonicalHistory,
      currentTurn: this.#activeTurn,
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
    this.#activeTurn = undefined;
  }

  startTurn(input: UserInput, priorHistory: readonly ModelMessage[]): void {
    const currentTurnMessage = userInputToModelMessage(input);
    this.#activeFrame = createInferenceFrame(this.#pendingEntries);
    this.#activeInferenceStarted = false;
    this.#activeStepEndOverlayInputAdded = false;
    this.#activeTurn = createCurrentTurnAnchor(
      priorHistory,
      currentTurnMessage
    );
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
  canonicalHistory,
  currentTurn,
  frame,
  history,
}: {
  readonly canonicalHistory?: readonly ModelMessage[];
  readonly currentTurn?: CurrentTurnAnchor;
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

  const snapshot = [...history];
  const pre = frame.preInferenceContext.map((entry) => entry.message);
  const post = frame.postInferenceContext.map((entry) => entry.message);
  const resolvedCurrentTurnIndex = resolveCurrentTurnIndex({
    canonicalHistory,
    currentTurn,
    history: snapshot,
  });

  if (resolvedCurrentTurnIndex === -1) {
    return structuredClone([...snapshot, ...pre, ...post]);
  }

  return structuredClone([
    ...snapshot.slice(0, resolvedCurrentTurnIndex),
    ...pre,
    ...snapshot.slice(resolvedCurrentTurnIndex),
    ...post,
  ]);
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

function summarizeOverlayInput(input: UserInput): OverlayInputSummary {
  if (input.type === "user-text") {
    const text =
      typeof input.text === "string" ? input.text : input.text.join("\n");
    return {
      preview: text ? "text" : "(empty message)",
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
    preview: summarizeNonTextParts(input.content),
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
