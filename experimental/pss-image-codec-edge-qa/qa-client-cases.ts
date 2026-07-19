import {
  loadFixture,
  noisyJpeg,
  solidJpeg,
  solidPng,
} from "./qa-client-support";

export interface ExpectOk {
  readonly bytes: Uint8Array;
  readonly expectByteIdentity?: boolean;
  readonly expectMagic: "jpeg" | "png" | "unknown";
  readonly expectMedia: string;
  readonly kind: "ok";
  readonly maxImageBytes?: number;
  readonly mediaType: string;
  readonly name: string;
  readonly skipSizeCap?: boolean;
}

export interface ExpectFail {
  readonly bytes: Uint8Array;
  readonly errorIncludes?: string;
  readonly kind: "fail";
  readonly maxImageBytes?: number;
  readonly mediaType: string;
  readonly name: string;
}

export type Case = ExpectOk | ExpectFail;

export function buildCases(): Case[] {
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
