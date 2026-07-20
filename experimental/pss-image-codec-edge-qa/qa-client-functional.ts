import type { Case } from "./qa-client-cases";
import { loadFixture, MAX_IMAGE_BYTES, normalize } from "./qa-client-support";

export async function runFunctional(cases: Case[]): Promise<number> {
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

export async function runConcurrent(): Promise<number> {
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
