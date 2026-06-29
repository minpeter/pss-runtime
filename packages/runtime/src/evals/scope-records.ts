import type { JudgeVerdict } from "./judge";
import type { AssertionHandle, AssertionRecord } from "./types";

export interface MutableRecord {
  failure?: string;
  label: string;
  passed: boolean;
  resolve?: () => Promise<JudgeVerdict>;
  score?: number;
  severity: AssertionRecord["severity"];
  strictOnly: boolean;
  threshold?: number;
}

export function handleFor(entry: MutableRecord): AssertionHandle {
  const build = (): AssertionHandle => ({
    gate: () => {
      entry.severity = "gate";
      entry.strictOnly = false;
      return build();
    },
    soft: (threshold) => {
      entry.severity = "soft";
      entry.strictOnly = true;
      entry.threshold = threshold;
      entry.passed =
        threshold === undefined ? true : (entry.score ?? 0) >= threshold;
      return build();
    },
    atLeast: (threshold) => {
      entry.severity = "soft";
      entry.strictOnly = true;
      entry.threshold = threshold;
      entry.passed = (entry.score ?? 0) >= threshold;
      return build();
    },
  });
  return build();
}
