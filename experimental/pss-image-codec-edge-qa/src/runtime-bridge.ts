/**
 * Bridge: import runtime sources + force edge wasm install before compress API.
 * Relative paths into packages/runtime so wrangler bundles codecs + wasm.
 */

export { installCloudflareImageCodecs } from "../../../packages/runtime/src/platform/cloudflare/image-codecs-edge";
export {
  DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
  prepareAttachmentBytesForStorage,
} from "../../../packages/runtime/src/thread/input/attachment-image-compress";
