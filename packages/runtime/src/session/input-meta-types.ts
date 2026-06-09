export type InputSource = "delegate" | "notify" | "send" | "steer";

export interface InputEventMeta {
  readonly delegateToolName?: string;
  readonly source: InputSource;
  readonly streaming?: "follow-up" | "steer";
}