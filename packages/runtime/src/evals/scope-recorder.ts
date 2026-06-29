import type { JudgeVerdict } from "./judge";
import { handleFor, type MutableRecord } from "./scope-records";
import type { AssertionHandle, AssertionRecord } from "./types";

export type PendingRecordResolver = () => Promise<JudgeVerdict>;

export class AssertionRecorder {
  readonly #records: MutableRecord[] = [];

  get records(): readonly AssertionRecord[] {
    return this.#records;
  }

  record(
    label: string,
    severity: AssertionRecord["severity"],
    pass: boolean,
    failure?: string,
    score?: number
  ): AssertionHandle {
    const entry: MutableRecord = {
      failure: pass ? undefined : failure,
      label,
      passed: pass,
      score,
      severity,
      strictOnly: severity === "soft",
    };
    this.#records.push(entry);
    return handleFor(entry);
  }

  recordPending(
    label: string,
    severity: AssertionRecord["severity"],
    resolve: PendingRecordResolver
  ): AssertionHandle {
    const entry: MutableRecord = {
      label,
      passed: true,
      resolve,
      severity,
      strictOnly: severity === "soft",
    };
    this.#records.push(entry);
    return handleFor(entry);
  }

  async resolvePending(): Promise<void> {
    for (const entry of this.#records) {
      if (!entry.resolve) {
        continue;
      }
      const verdict = await entry.resolve();
      entry.resolve = undefined;
      entry.score = verdict.score;
      entry.failure = verdict.reason;
      entry.passed =
        entry.threshold === undefined
          ? verdict.pass
          : verdict.score >= entry.threshold;
    }
  }
}
