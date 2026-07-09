import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { prepareAttachmentBytesForStorage } from "../src/thread/input/attachment-image-compress";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/thread/input/fixtures"
);

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

async function bench(
  name: string,
  fn: () => Promise<unknown>,
  n = 5
): Promise<void> {
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length / 2)] ?? 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `${name}: p50=${p50.toFixed(0)} mean=${mean.toFixed(0)} min=${samples[0]?.toFixed(0)} max=${samples[samples.length - 1]?.toFixed(0)}`
  );
}

async function main(): Promise<void> {
  const heic = new Uint8Array(readFileSync(join(fixturesDir, "sample.heic")));
  const avif = new Uint8Array(readFileSync(join(fixturesDir, "sample.avif")));
  const webp = new Uint8Array(readFileSync(join(fixturesDir, "sample.webp")));
  const over = noisyJpeg(1400, 1400, 95);
  console.log("oversize bytes", over.byteLength);

  await bench("heic", () =>
    prepareAttachmentBytesForStorage({ bytes: heic, mediaType: "image/heic" })
  );
  await bench("avif", () =>
    prepareAttachmentBytesForStorage({ bytes: avif, mediaType: "image/avif" })
  );
  await bench("webp", () =>
    prepareAttachmentBytesForStorage({ bytes: webp, mediaType: "image/webp" })
  );
  await bench(
    "oversize-jpeg",
    () =>
      prepareAttachmentBytesForStorage({
        bytes: over,
        mediaType: "image/jpeg",
      }),
    3
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
