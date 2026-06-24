import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  DurableTurnInspectionResult,
  DurableTurnInspectionSource,
} from "../execution";
import { inspectDurableTurn } from "../execution";

describe("runtime execution subpath exports", () => {
  it("exports durable turn inspection from the execution subpath only", async () => {
    const runtime = await import("../index");
    const execution = await import("../execution");

    expect(runtime).not.toHaveProperty("inspectDurableTurn");
    expect(execution).toHaveProperty("inspectDurableTurn", inspectDurableTurn);
    expectTypeOf<
      Parameters<typeof inspectDurableTurn>[0]
    >().toEqualTypeOf<DurableTurnInspectionSource>();
    expectTypeOf<
      Awaited<ReturnType<typeof inspectDurableTurn>>
    >().toEqualTypeOf<DurableTurnInspectionResult>();
  });
});
