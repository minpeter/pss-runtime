import {
  BENCH_RUNS,
  loadFixture,
  MAX_IMAGE_BYTES,
  noisyJpeg,
  normalize,
  percentile,
  solidJpeg,
} from "./qa-client-support";

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

export async function runBench(): Promise<number> {
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
