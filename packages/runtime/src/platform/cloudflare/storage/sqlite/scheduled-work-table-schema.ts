import type { SqlStorage } from "../../sql/ports/storage-port";

export function hasScheduledWorkColumn(
  sql: SqlStorage,
  column: string
): boolean {
  return sql
    .exec<{ readonly name: string }>("PRAGMA table_info(pss_scheduled_work)")
    .toArray()
    .some((row) => row.name === column);
}
