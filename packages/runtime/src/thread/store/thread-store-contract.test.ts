import { describe, expect, it } from "vitest";
import type { ThreadStore } from "./types";

type AssertFalse<T extends false> = T;
type RejectsExecutionCapabilities = AssertFalse<
  "capabilities" extends keyof ThreadStore ? true : false
>;

const rejectsExecutionCapabilities: RejectsExecutionCapabilities = false;

describe("ThreadStore contract", () => {
  it("thread store exposes no execution capabilities", () => {
    expect(rejectsExecutionCapabilities).toBe(false);
  });
});
