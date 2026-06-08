import { describe, expect, it } from "vitest";
import type { SessionStore } from "./types";

type AssertFalse<T extends false> = T;
type RejectsExecutionCapabilities = AssertFalse<
  "capabilities" extends keyof SessionStore ? true : false
>;

const rejectsExecutionCapabilities: RejectsExecutionCapabilities = false;

describe("SessionStore contract", () => {
  it("session store exposes no execution capabilities", () => {
    expect(rejectsExecutionCapabilities).toBe(false);
  });
});
