// biome-ignore-all lint/performance/noBarrelFile: Legacy package subpath compatibility entrypoint.

export {
  /** @deprecated Use FileThreadStore. */
  FileSessionStore,
  FileThreadStore,
} from "../../platform/node/storage/file-thread-store";
