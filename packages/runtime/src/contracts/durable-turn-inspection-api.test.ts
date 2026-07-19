import { describe, expect, expectTypeOf, it } from "vitest";
import type { HostStore } from "../execution";
import {
  type DurableTurnInspectionResult,
  type DurableTurnInspectionSource,
  inspectDurableTurn,
} from "../execution";
import type { AgentTurn } from "../index";

describe("durable turn inspection public API", () => {
  it("keeps inspection on the existing execution subpath", async () => {
    const execution = await import("../execution");
    const runtime = await import("../index");

    expect(execution).toHaveProperty("inspectDurableTurn", inspectDurableTurn);
    expect(runtime).not.toHaveProperty("inspectDurableTurn");
  });

  it("types correlation and inspection without changing the turn event model", () => {
    expectTypeOf<AgentTurn["runId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<HostStore>().toMatchTypeOf<DurableTurnInspectionSource>();
    expectTypeOf<
      Awaited<ReturnType<typeof inspectDurableTurn>>
    >().toEqualTypeOf<DurableTurnInspectionResult>();
    expectTypeOf<AgentTurn["events"]>().toBeFunction();
  });
});
