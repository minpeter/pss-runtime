import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("uploads timing evidence on Node 24 even after the producer fails", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const producer = steps.findIndex((step) => step.run === "pnpm test:timing");
  const upload = steps.findIndex(
    (step) => step.with?.path === "report/test-timing.json"
  );

  expect(producer).toBeGreaterThanOrEqual(0);
  expect(upload).toBeGreaterThan(producer);
  expect(steps[upload].if).toBe(`\${{ always() && matrix.node == '24' }}`);
  expect(steps[upload].with["retention-days"]).toBe(7);
  expect(steps[producer]["continue-on-error"]).not.toBe(true);
});
