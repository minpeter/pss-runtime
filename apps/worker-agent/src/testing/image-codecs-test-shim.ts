/**
 * Node/vitest shim for edge image codec install.
 * Real Workers load static .wasm via image-codecs-edge.
 */
export function installCloudflareImageCodecs(): void {
  // no-op under vitest
}
