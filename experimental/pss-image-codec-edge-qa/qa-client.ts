/**
 * Edge QA + bench against a deployed/dev Cloudflare Worker.
 *
 * Usage:
 *   EDGE_QA_URL=https://pss-image-codec-edge-qa.<sub>.workers.dev pnpm test:edge
 *   EDGE_QA_URL=http://127.0.0.1:8787 pnpm test:edge
 *   EDGE_QA_BENCH_RUNS=10 EDGE_QA_URL=... pnpm test:edge
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";

const baseUrl = (process.env.EDGE_QA_URL ?? "http://127.0.0.1:8787").replace(
  /\/$/,
  ""
);
const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/runtime/src/thread/input/fixtures"
);
const BENCH_RUNS = Math.max(3, Number(process.env.EDGE_QA_BENCH_RUNS ?? 10));
const MAX_IMAGE_BYTES = 1_000_000;

interface NormalizeResponse {
  readonly byteLength?: number;
  readonly error?: string;
  readonly inputByteLength?: number;
  readonly magic?: string;
  readonly mediaType?: string;
  readonly ok: boolean;
}

interface ExpectOk {
  readonly bytes: Uint8Array;
  /** When true, output bytes must equal input (non-image passthrough). */
  readonly expectByteIdentity?: boolean;
  readonly expectMagic: "jpeg" | "png" | "unknown";
  readonly expectMedia: string;
  readonly kind: "ok";
  readonly maxImageBytes?: number;
  readonly mediaType: string;
  readonly name: string;
  /** Skip ≤1MB check (small passthrough / under-budget alpha / non-image). */
  readonly skipSizeCap?: boolean;
}

interface ExpectFail {
  readonly bytes: Uint8Array;
  readonly errorIncludes?: string;
  readonly kind: "fail";
  readonly maxImageBytes?: number;
  readonly mediaType: string;
  readonly name: string;
}

type Case = ExpectOk | ExpectFail;

async function normalize(
  mediaType: string,
  bytes: Uint8Array,
  maxImageBytes?: number
): Promise<{ status: number; body: NormalizeResponse; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/normalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mediaType,
      dataBase64: bytesToBase64(bytes),
      maxImageBytes,
    }),
  });
  const body = (await res.json()) as NormalizeResponse;
  return { status: res.status, body, ms: performance.now() - t0 };
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
}

function solidJpeg(w: number, h: number, q: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 10;
    data[i + 1] = 20;
    data[i + 2] = 200;
    data[i + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, q).data);
}

function solidPng(w: number, h: number, alpha: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 40;
    data[i + 2] = 40;
    data[i + 3] = alpha;
  }
  return encodePng({ width: w, height: h, data, channels: 4, depth: 8 });
}

function noisyJpeg(w: number, h: number, q: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 17) % 256;
    data[i + 1] = (i * 31) % 256;
    data[i + 2] = (i * 47) % 256;
    data[i + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, q).data);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx] ?? Number.NaN;
}

function buildCases(): Case[] {
  return [
    {
      kind: "ok",
      name: "small-jpeg-passthrough",
      mediaType: "image/jpeg",
      bytes: solidJpeg(48, 48, 80),
      expectMedia: "image/jpeg",
      expectMagic: "jpeg",
      skipSizeCap: true,
    },
    {
      kind: "ok",
      name: "small-png-passthrough",
      mediaType: "image/png",
      bytes: solidPng(32, 32, 255),
      expectMedia: "image/png",
      expectMagic: "png",
      skipSizeCap: true,
    },
    {
      kind: "ok",
      name: "transparent-png",
      mediaType: "image/png",
      bytes: solidPng(40, 40, 128),
      expectMedia: "image/png",
      expectMagic: "png",
      skipSizeCap: true,
    },
    {
      kind: "ok",
      name: "oversize-jpeg",
      mediaType: "image/jpeg",
      bytes: noisyJpeg(1400, 1400, 95),
      expectMedia: "image/jpeg",
      expectMagic: "jpeg",
    },
    {
      kind: "ok",
      name: "extreme-jpeg-2200",
      mediaType: "image/jpeg",
      bytes: noisyJpeg(2200, 2200, 90),
      expectMedia: "image/jpeg",
      expectMagic: "jpeg",
    },
    {
      kind: "ok",
      name: "heic-fixture",
      mediaType: "image/heic",
      bytes: loadFixture("sample.heic"),
      expectMedia: "image/jpeg",
      expectMagic: "jpeg",
    },
    {
      kind: "ok",
      name: "heic-wrong-mime-jpeg",
      mediaType: "image/jpeg",
      bytes: loadFixture("sample.heic"),
      expectMedia: "image/jpeg",
      expectMagic: "jpeg",
    },
    {
      kind: "ok",
      name: "heic-octet-stream",
      mediaType: "application/octet-stream",
      bytes: loadFixture("sample.heic"),
      expectMedia: "image/jpeg",
      expectMagic: "jpeg",
    },
    {
      kind: "ok",
      name: "avif-fixture",
      mediaType: "image/avif",
      bytes: loadFixture("sample.avif"),
      expectMedia: "image/jpeg",
      expectMagic: "jpeg",
    },
    {
      kind: "ok",
      name: "webp-fixture",
      mediaType: "image/webp",
      bytes: loadFixture("sample.webp"),
      expectMedia: "image/jpeg",
      expectMagic: "jpeg",
    },
    {
      kind: "ok",
      name: "webp-alpha",
      mediaType: "image/webp",
      bytes: loadFixture("sample-alpha.webp"),
      expectMedia: "image/png",
      expectMagic: "png",
      skipSizeCap: true,
    },
    {
      kind: "ok",
      name: "non-image-pdf-passthrough",
      mediaType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
      expectMedia: "application/pdf",
      expectMagic: "unknown",
      skipSizeCap: true,
      expectByteIdentity: true,
    },
    {
      kind: "fail",
      name: "corrupt-truncated-heic",
      mediaType: "image/heic",
      bytes: loadFixture("corrupt-truncated.heic"),
    },
    {
      kind: "fail",
      name: "corrupt-garbage-webp",
      mediaType: "image/webp",
      bytes: loadFixture("corrupt-garbage.webp"),
    },
    {
      kind: "fail",
      name: "corrupt-truncated-jpeg",
      mediaType: "image/jpeg",
      bytes: loadFixture("corrupt-truncated.jpeg"),
    },
    {
      kind: "fail",
      name: "corrupt-truncated-avif",
      mediaType: "image/avif",
      bytes: loadFixture("corrupt-truncated.avif"),
    },
    {
      kind: "fail",
      name: "empty-png",
      mediaType: "image/png",
      bytes: new Uint8Array(0),
    },
  ];
}

async function runFunctional(cases: Case[]): Promise<number> {
  let failed = 0;
  for (const c of cases) {
    const { status, body, ms } = await normalize(
      c.mediaType,
      c.bytes,
      c.maxImageBytes
    );
    if (c.kind === "fail") {
      if (body.ok || status < 400) {
        console.error(
          `FAIL ${c.name}: expected error, got ok`,
          body,
          `(${ms.toFixed(0)}ms)`
        );
        failed += 1;
      } else {
        console.log(
          `OK   ${c.name}: fail-as-expected status=${status} err=${body.error?.slice(0, 80)} (${ms.toFixed(0)}ms)`
        );
      }
      continue;
    }

    if (!body.ok) {
      console.error(`FAIL ${c.name}: ${body.error} (${ms.toFixed(0)}ms)`);
      failed += 1;
      continue;
    }
    const mediaOk = body.mediaType === c.expectMedia;
    const magicOk = body.magic === c.expectMagic;
    const sizeOk =
      c.skipSizeCap ||
      (body.byteLength ?? Number.POSITIVE_INFINITY) <= MAX_IMAGE_BYTES;
    const identityOk =
      !c.expectByteIdentity || body.byteLength === c.bytes.byteLength;
    if (mediaOk && magicOk && sizeOk && identityOk) {
      console.log(
        `OK   ${c.name}: ${body.mediaType} magic=${body.magic} in=${body.inputByteLength} out=${body.byteLength} (${ms.toFixed(0)}ms)`
      );
    } else {
      console.error(`FAIL ${c.name}:`, body, `(${ms.toFixed(0)}ms)`);
      failed += 1;
    }
  }
  return failed;
}

async function runConcurrent(): Promise<number> {
  const payloads = [
    {
      name: "heic",
      mediaType: "image/heic",
      bytes: loadFixture("sample.heic"),
    },
    {
      name: "avif",
      mediaType: "image/avif",
      bytes: loadFixture("sample.avif"),
    },
    {
      name: "webp",
      mediaType: "image/webp",
      bytes: loadFixture("sample.webp"),
    },
    {
      name: "alpha-webp",
      mediaType: "image/webp",
      bytes: loadFixture("sample-alpha.webp"),
    },
  ] as const;

  const t0 = performance.now();
  const results = await Promise.all(
    payloads.map((p) => normalize(p.mediaType, p.bytes))
  );
  const wall = performance.now() - t0;

  let failed = 0;
  const expected: Record<string, string> = {
    heic: "image/jpeg",
    avif: "image/jpeg",
    webp: "image/jpeg",
    "alpha-webp": "image/png",
  };
  for (let i = 0; i < payloads.length; i += 1) {
    const p = payloads[i];
    const r = results[i];
    if (!(p && r)) {
      failed += 1;
      continue;
    }
    if (!r.body.ok || r.body.mediaType !== expected[p.name]) {
      console.error(`FAIL concurrent-${p.name}:`, r.body);
      failed += 1;
    } else if (
      (r.body.byteLength ?? Number.POSITIVE_INFINITY) > MAX_IMAGE_BYTES
    ) {
      console.error(`FAIL concurrent-${p.name}: oversize`, r.body);
      failed += 1;
    } else {
      console.log(
        `OK   concurrent-${p.name}: ${r.body.mediaType} out=${r.body.byteLength} (${r.ms.toFixed(0)}ms)`
      );
    }
  }
  console.log(
    `     concurrent wall=${wall.toFixed(0)}ms for ${payloads.length} parallel`
  );
  return failed;
}

function benchHardCapMs(name: string): number {
  if (name === "bench-oversize-jpeg") {
    return 30_000;
  }
  if (name === "bench-avif" || name === "bench-heic") {
    return 15_000;
  }
  return 5000;
}

async function warmupBenchTarget(
  name: string,
  mediaType: string,
  bytes: Uint8Array
): Promise<boolean> {
  for (let w = 0; w < 2; w += 1) {
    const warm = await normalize(mediaType, bytes);
    if (!warm.body.ok) {
      console.error(`FAIL ${name} warmup: ${warm.body.error}`);
      return false;
    }
  }
  return true;
}

async function sampleBenchTarget(
  name: string,
  mediaType: string,
  bytes: Uint8Array
): Promise<number[] | undefined> {
  const samples: number[] = [];
  for (let i = 0; i < BENCH_RUNS; i += 1) {
    const r = await normalize(mediaType, bytes);
    if (!r.body.ok) {
      console.error(`FAIL ${name} run ${i}: ${r.body.error}`);
      return;
    }
    if (
      !name.includes("small") &&
      (r.body.byteLength ?? Number.POSITIVE_INFINITY) > MAX_IMAGE_BYTES
    ) {
      console.error(`FAIL ${name} oversize out=${r.body.byteLength}`);
      return;
    }
    samples.push(r.ms);
  }
  return samples;
}

function logBenchStats(name: string, samples: number[]): number {
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const min = samples[0] ?? 0;
  const max = samples.at(-1) ?? 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `BENCH ${name}: n=${samples.length} min=${min.toFixed(0)} p50=${p50.toFixed(0)} mean=${mean.toFixed(0)} p95=${p95.toFixed(0)} max=${max.toFixed(0)} ms`
  );
  return p95;
}

async function runBench(): Promise<number> {
  const targets = [
    {
      name: "bench-jpeg-small",
      mediaType: "image/jpeg",
      bytes: solidJpeg(64, 64, 80),
    },
    {
      name: "bench-heic",
      mediaType: "image/heic",
      bytes: loadFixture("sample.heic"),
    },
    {
      name: "bench-avif",
      mediaType: "image/avif",
      bytes: loadFixture("sample.avif"),
    },
    {
      name: "bench-webp",
      mediaType: "image/webp",
      bytes: loadFixture("sample.webp"),
    },
    {
      name: "bench-oversize-jpeg",
      mediaType: "image/jpeg",
      bytes: noisyJpeg(1400, 1400, 95),
    },
  ] as const;

  let failed = 0;
  console.log(
    `\n--- Warm latency bench (${BENCH_RUNS} runs after 2 warmup) ---`
  );

  for (const t of targets) {
    if (!(await warmupBenchTarget(t.name, t.mediaType, t.bytes))) {
      failed += 1;
      continue;
    }
    const samples = await sampleBenchTarget(t.name, t.mediaType, t.bytes);
    if (!samples || samples.length === 0) {
      failed += 1;
      continue;
    }
    const p95 = logBenchStats(t.name, samples);
    if (p95 > benchHardCapMs(t.name)) {
      console.error(
        `FAIL ${t.name}: p95 ${p95.toFixed(0)}ms exceeds hard cap ${benchHardCapMs(t.name)}ms`
      );
      failed += 1;
    }
  }
  return failed;
}

async function main(): Promise<void> {
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
