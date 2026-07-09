/**
 * Temporary Cloudflare Worker to QA image attachment normalization on edge.
 *
 * POST /normalize
 * body: { mediaType: string, dataBase64: string, maxImageBytes?: number }
 * response: { ok, mediaType, byteLength, magic, error? }
 */

import {
  installCloudflareImageCodecs,
  prepareAttachmentBytesForStorage,
} from "./runtime-bridge";

installCloudflareImageCodecs();

interface NormalizeRequest {
  readonly dataBase64: string;
  readonly maxImageBytes?: number;
  readonly mediaType: string;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "pss-image-codec-edge-qa" });
    }

    if (request.method === "POST" && url.pathname === "/normalize") {
      try {
        const body = (await request.json()) as NormalizeRequest;
        if (
          typeof body.mediaType !== "string" ||
          typeof body.dataBase64 !== "string"
        ) {
          return Response.json(
            { ok: false, error: "mediaType and dataBase64 required" },
            { status: 400 }
          );
        }
        const bytes = base64ToBytes(body.dataBase64);
        const prepared = await prepareAttachmentBytesForStorage({
          bytes,
          maxImageBytes: body.maxImageBytes,
          mediaType: body.mediaType,
        });
        return Response.json({
          ok: true,
          mediaType: prepared.mediaType,
          byteLength: prepared.bytes.byteLength,
          magic: detectMagic(prepared.bytes),
          inputByteLength: bytes.byteLength,
          // Echo so clients can assert non-image passthrough preserved media type.
          inputMediaType: body.mediaType,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }

    return new Response("not found", { status: 404 });
  },
};

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function detectMagic(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  return "unknown";
}
