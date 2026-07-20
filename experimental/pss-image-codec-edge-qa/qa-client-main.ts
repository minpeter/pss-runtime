import { runBench } from "./qa-client-bench";
import { buildCases } from "./qa-client-cases";
import { runConcurrent, runFunctional } from "./qa-client-functional";
import { baseUrl } from "./qa-client-support";

export async function main(): Promise<void> {
  console.log(`QA against ${baseUrl}`);
  const health = await fetch(`${baseUrl}/health`);
  if (!health.ok) {
    throw new Error(`health failed: ${health.status}`);
  }
  console.log("health ok\n--- Functional matrix ---");

  const cases = buildCases();
  let failed = 0;
  failed += await runFunctional(cases);
  console.log("\n--- Concurrent multi-format ---");
  failed += await runConcurrent();
  failed += await runBench();

  if (failed > 0) {
    console.error(`\n${failed} case(s) failed`);
    process.exit(1);
  }
  console.log("\nAll edge QA + concurrent + bench cases passed");
}
