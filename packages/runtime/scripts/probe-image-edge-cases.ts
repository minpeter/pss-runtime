import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { prepareAttachmentBytesForStorage } from "../src/thread/input/attachment-image-compress";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/thread/input/fixtures"
);

async function main(): Promise<void> {
  const alpha = new Uint8Array(
    readFileSync(join(fixturesDir, "sample-alpha.webp"))
  );
  const r = await prepareAttachmentBytesForStorage({
    bytes: alpha,
    mediaType: "image/webp",
  });
  console.log("alpha webp ->", r.mediaType, r.bytes.byteLength);

  const heic = new Uint8Array(readFileSync(join(fixturesDir, "sample.heic")));
  const r2 = await prepareAttachmentBytesForStorage({
    bytes: heic,
    mediaType: "image/jpeg",
  });
  console.log("heic as jpeg mime ->", r2.mediaType, r2.bytes.byteLength);

  const r3 = await prepareAttachmentBytesForStorage({
    bytes: heic,
    mediaType: "application/octet-stream",
  });
  console.log("heic octet ->", r3.mediaType, r3.bytes.byteLength);

  for (const f of [
    "corrupt-truncated.heic",
    "corrupt-garbage.webp",
    "corrupt-truncated.jpeg",
    "corrupt-truncated.avif",
  ] as const) {
    try {
      const b = new Uint8Array(readFileSync(join(fixturesDir, f)));
      let mt = "image/jpeg";
      if (f.includes("heic")) {
        mt = "image/heic";
      } else if (f.includes("webp")) {
        mt = "image/webp";
      } else if (f.includes("avif")) {
        mt = "image/avif";
      }
      const out = await prepareAttachmentBytesForStorage({
        bytes: b,
        mediaType: mt,
      });
      console.log("UNEXPECTED OK", f, out.mediaType, out.bytes.byteLength);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("expected fail", f, message.slice(0, 140));
    }
  }

  const webp = new Uint8Array(readFileSync(join(fixturesDir, "sample.webp")));
  const avif = new Uint8Array(readFileSync(join(fixturesDir, "sample.avif")));
  const t0 = performance.now();
  const outs = await Promise.all([
    prepareAttachmentBytesForStorage({ bytes: heic, mediaType: "image/heic" }),
    prepareAttachmentBytesForStorage({ bytes: avif, mediaType: "image/avif" }),
    prepareAttachmentBytesForStorage({ bytes: webp, mediaType: "image/webp" }),
    prepareAttachmentBytesForStorage({ bytes: alpha, mediaType: "image/webp" }),
  ]);
  console.log(
    "concurrent",
    outs.map((o) => `${o.mediaType}/${o.bytes.byteLength}`),
    `${(performance.now() - t0).toFixed(0)}ms`
  );

  try {
    await prepareAttachmentBytesForStorage({
      bytes: new Uint8Array(0),
      mediaType: "image/png",
    });
    console.log("empty unexpected ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("empty fail", message.slice(0, 100));
  }

  const w = 2200;
  const h = 2200;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 13) % 256;
    data[i + 1] = (i * 29) % 256;
    data[i + 2] = (i * 41) % 256;
    data[i + 3] = 255;
  }
  const big = new Uint8Array(
    jpeg.encode({ data, width: w, height: h }, 90).data
  );
  console.log("extreme in", big.byteLength);
  const t1 = performance.now();
  const re = await prepareAttachmentBytesForStorage({
    bytes: big,
    mediaType: "image/jpeg",
  });
  console.log(
    "extreme out",
    re.mediaType,
    re.bytes.byteLength,
    `${(performance.now() - t1).toFixed(0)}ms`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
