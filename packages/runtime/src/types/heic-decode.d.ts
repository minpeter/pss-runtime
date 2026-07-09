declare module "heic-decode" {
  export interface HeicDecodedImage {
    readonly data: Uint8ClampedArray;
    readonly height: number;
    readonly width: number;
  }

  export interface HeicDecodeInput {
    readonly buffer: ArrayBuffer | ArrayBufferView | Buffer | Uint8Array;
  }

  export default function decode(
    input: HeicDecodeInput
  ): Promise<HeicDecodedImage>;
}
