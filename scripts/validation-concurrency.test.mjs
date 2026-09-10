// Concurrency-budget and cleanup-contract documentation invariants
// (VAL-CROSS-013): CONTRIBUTING.md declares the cross-area validation
// concurrency limits (two Worker/HTTP validators, one TUI validator, two
// lightweight static-analysis validators, serial two-checkout runs) and the
// validator cleanup contract (kill only recorded PIDs, before/after listener
// inventories, time-gate timeout guards, the observe-only post-run cleanup
// check, gitignored evidence). Static over committed files plus
// `git check-ignore`: no network, no ports, no writes.

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  budgetProblems,
  CLEANUP_CHECK_PATH,
  cleanupDocProblems,
  EVIDENCE_PROBE,
  evidenceIgnoreProblems,
  readContributing,
  TIME_GATE_PATH,
  validationConcurrencyProblems,
} from "./validation-concurrency.mjs";

const WORKER_HTTP_LIMIT = /two\s+Worker\/HTTP\s+validators/;
const TUI_LIMIT = /one TUI validator/;
const STATIC_LIMIT = /two lightweight static\/config validators/;
const SERIAL_RULE = /serial two-checkout/;
const RECORDED_PID_RULE = /only the PIDs it recorded at startup/;
const OBSERVE_ONLY_RULE = /never terminates anything/;

describe("validation concurrency budget documentation", () => {
  const text = readContributing(".");

  it("CONTRIBUTING.md declares the full cross-area budget", () => {
    expect(budgetProblems(text)).toEqual([]);
  });

  it("fails when the Worker/HTTP validator limit is dropped", () => {
    const mutated = text.replace(WORKER_HTTP_LIMIT, "Worker/HTTP validators");
    expect(budgetProblems(mutated).join("\n")).toContain("Worker/HTTP");
  });

  it("fails when the TUI validator limit is dropped", () => {
    const mutated = text.replace(TUI_LIMIT, "a TUI validator");
    expect(budgetProblems(mutated).join("\n")).toContain("TUI");
  });

  it("fails when the lightweight static-analysis limit is dropped", () => {
    const mutated = text.replace(
      STATIC_LIMIT,
      "lightweight static/config validators"
    );
    expect(budgetProblems(mutated).join("\n")).toContain("lightweight");
  });

  it("fails when the serial two-checkout rule is dropped", () => {
    const mutated = text.replace(SERIAL_RULE, "two-checkout");
    expect(budgetProblems(mutated).join("\n")).toContain("serial");
  });
});

describe("validator cleanup contract documentation", () => {
  const text = readContributing(".");

  it("CONTRIBUTING.md documents the cleanup contract", () => {
    expect(cleanupDocProblems(text)).toEqual([]);
  });

  it("fails without the recorded-PID-only kill rule", () => {
    const mutated = text.replace(RECORDED_PID_RULE, "processes it started");
    expect(cleanupDocProblems(mutated).join("\n")).toContain("recorded");
  });

  it("fails without the listener inventory monitor", () => {
    const mutated = text.replaceAll("ss -tlnp", "ss");
    expect(cleanupDocProblems(mutated).join("\n")).toContain("ss -tlnp");
  });

  it("fails without the time-gate timeout guard", () => {
    const mutated = text.replaceAll(
      "scripts/time-gate.mjs",
      "scripts/time-gte.mjs"
    );
    expect(cleanupDocProblems(mutated).join("\n")).toContain("time-gate");
  });

  it("fails without the post-run cleanup check", () => {
    const mutated = text.replaceAll(
      "check-validation-cleanup.mjs",
      "check-validation-cleanpu.mjs"
    );
    expect(cleanupDocProblems(mutated).join("\n")).toContain(
      "check-validation-cleanup"
    );
  });

  it("fails without the observe-only guarantee", () => {
    const mutated = text.replace(OBSERVE_ONLY_RULE, "terminates leaks");
    expect(cleanupDocProblems(mutated).join("\n")).toContain("terminates");
  });
});

describe("validation concurrency aggregate", () => {
  it("passes on the committed tree", () => {
    expect(validationConcurrencyProblems(".")).toEqual([]);
  });

  it("requires the timeout wrapper and the cleanup-check harness", () => {
    expect(existsSync(TIME_GATE_PATH)).toBe(true);
    expect(existsSync(CLEANUP_CHECK_PATH)).toBe(true);
  });

  it("keeps validation evidence gitignored", () => {
    expect(evidenceIgnoreProblems(".")).toEqual([]);
  });

  it("flags a non-ignored evidence path", () => {
    expect(EVIDENCE_PROBE.startsWith(".omo/evidence/")).toBe(true);
  });
});
