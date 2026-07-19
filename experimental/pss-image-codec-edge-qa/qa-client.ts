/**
 * Edge QA + bench against a deployed/dev Cloudflare Worker.
 *
 * Usage:
 *   EDGE_QA_URL=https://pss-image-codec-edge-qa.<sub>.workers.dev pnpm test:edge
 *   EDGE_QA_URL=http://127.0.0.1:8787 pnpm test:edge
 *   EDGE_QA_BENCH_RUNS=10 EDGE_QA_URL=... pnpm test:edge
 */

import { main } from "./qa-client-main";

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
