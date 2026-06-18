// biome-ignore-all lint/performance/noBarrelFile: Deprecated package subpath compatibility entrypoint required by package exports.
export {
  DurableObjectSqliteThreadStore,
  /** @deprecated Use DurableObjectSqliteThreadStore. */
  DurableObjectSqliteThreadStore as DurableObjectSqliteSessionStore,
} from "./thread-store";
