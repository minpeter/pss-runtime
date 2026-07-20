import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";

export const baseUrl = (
  process.env.EDGE_QA_URL ?? "http://127.0.0.1:8787"
).replace(/\/$/, "");
const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/runtime/src/thread/input/fixtures"
);
export const BENCH_RUNS = Math.max(
  3,
  Number(process.env.EDGE_QA_BENCH_RUNS ?? 10)
);
export const MAX_IMAGE_BYTES = 1_000_000;

export interface NormalizeResponse {
  readonly byteLength?: number;
  readonly error?: string;
  readonly inputByteLength?: number;
  readonly magic?: string;
  readonly mediaType?: string;
  readonly ok: boolean;
}

export async function normalize(
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

export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
}

export function solidJpeg(w: number, h: number, q: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 10;
    data[i + 1] = 20;
    data[i + 2] = 200;
    data[i + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, q).data);
}

export function solidPng(w: number, h: number, alpha: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 40;
    data[i + 2] = 40;
    data[i + 3] = alpha;
  }
  return encodePng({ width: w, height: h, data, channels: 4, depth: 8 });
}

export function noisyJpeg(w: number, h: number, q: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 17) % 256;
    data[i + 1] = (i * 31) % 256;
    data[i + 2] = (i * 47) % 256;
    data[i + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width: w, height: h }, q).data);
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx] ?? Number.NaN;
}
