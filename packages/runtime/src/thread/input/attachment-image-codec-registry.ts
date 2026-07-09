/**
 * Edge-first image codec WASM registry.
 *
 * Cloudflare Workers cannot reliably `fetch()` codec wasm at runtime and do not
 * have a package filesystem. Apps / platform adapters must install wasm modules
 * (typically via static `import … from "*.wasm"` that wrangler bundles).
 *
 * Node/Vitest can install from disk via {@link installImageCodecWasmFromNodeModules}.
 */

export interface ImageCodecWasmModules {
  readonly avifDecodeWasm?: WebAssembly.Module | object;
  readonly heifDecodeWasm?: WebAssembly.Module | object;
  readonly webpDecodeWasm?: WebAssembly.Module | object;
}

let installed: ImageCodecWasmModules = {};
let nodeInstallPromise: Promise<void> | undefined;

export function getInstalledImageCodecWasm(): ImageCodecWasmModules {
  return installed;
}

/**
 * Install wasm modules for image decode. Safe to call multiple times;
 * later calls merge over previous modules.
 *
 * On Cloudflare Workers, modules must be static `import … from "*.wasm"`
 * results (WebAssembly.Module). Compiling from raw bytes is rejected by the
 * embedder ("Wasm code generation disallowed").
 */
export function installImageCodecWasm(modules: ImageCodecWasmModules): void {
  installed = {
    ...installed,
    ...modules,
  };
}

export function hasAvifDecodeWasm(): boolean {
  return installed.avifDecodeWasm !== undefined;
}

export function hasWebpDecodeWasm(): boolean {
  return installed.webpDecodeWasm !== undefined;
}

export function hasHeifDecodeWasm(): boolean {
  return installed.heifDecodeWasm !== undefined;
}

/**
 * Node-only helper: load wasm binaries from installed npm packages.
 * No-ops (resolves) when `node:fs` / package paths are unavailable.
 */
export async function installImageCodecWasmFromNodeModules(): Promise<void> {
  if (nodeInstallPromise) {
    await nodeInstallPromise;
    return;
  }
  nodeInstallPromise = (async () => {
    try {
      const { createRequire } = await import("node:module");
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const require = createRequire(import.meta.url);

      const loadWasm = async (
        packageName: string,
        rel: string
      ): Promise<WebAssembly.Module> => {
        const pkgDir = path.dirname(
          require.resolve(`${packageName}/package.json`)
        );
        const bytes = readFileSync(path.join(pkgDir, rel));
        return await WebAssembly.compile(bytes);
      };

      const [avifDecodeWasm, webpDecodeWasm, heifDecodeWasm] =
        await Promise.all([
          loadWasm("@jsquash/avif", "codec/dec/avif_dec.wasm"),
          loadWasm("@jsquash/webp", "codec/dec/webp_dec.wasm"),
          loadWasm("libheif-js", "libheif-wasm/libheif.wasm"),
        ]);

      installImageCodecWasm({
        avifDecodeWasm,
        heifDecodeWasm,
        webpDecodeWasm,
      });
    } catch {
      // Edge / browser: caller must install via installImageCodecWasm.
    }
  })();
  await nodeInstallPromise;
}
