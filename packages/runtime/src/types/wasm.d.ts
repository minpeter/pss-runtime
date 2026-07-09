declare module "*.wasm" {
  const value: WebAssembly.Module;
  export default value;
}

declare module "@jsquash/avif/codec/dec/avif_dec.wasm" {
  const value: WebAssembly.Module;
  export default value;
}

declare module "@jsquash/webp/codec/dec/webp_dec.wasm" {
  const value: WebAssembly.Module;
  export default value;
}

declare module "libheif-js/libheif-wasm/libheif.wasm" {
  const value: WebAssembly.Module;
  export default value;
}
