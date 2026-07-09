declare module "heic-decode" {
  export interface HeicDecodeInput {
    readonly buffer: ArrayBuffer;
  }

  export interface HeicDecodeResult {
    readonly data: ArrayBuffer | Uint8Array;
    readonly height: number;
    readonly width: number;
  }

  export default function decode(
    input: HeicDecodeInput
  ): Promise<HeicDecodeResult>;
}
