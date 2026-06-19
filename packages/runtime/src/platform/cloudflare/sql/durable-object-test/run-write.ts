import {
  nullableStringBinding,
  numberBinding,
  stringBinding,
} from "./bindings";
import type { InMemoryDurableObjectSqlState, RunRow } from "./state";

export function writeRunStatement(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): boolean {
  if (query.startsWith("insert into pss_run")) {
    upsertRun(state, bindings);
    return true;
  }
  if (query.startsWith("delete from pss_run")) {
    deleteRun(state, bindings);
    return true;
  }
  return false;
}

function upsertRun(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const row = createRunRow(bindings);
  state.runs = state.runs.filter(
    (existing) =>
      !(existing.prefix === row.prefix && existing.run_id === row.run_id)
  );
  state.runs.push(row);
}

function deleteRun(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[0]);
  const runId = stringBinding(bindings[1]);
  state.runs = state.runs.filter(
    (row) => !(row.prefix === prefix && row.run_id === runId)
  );
}

function createRunRow(bindings: readonly unknown[]): RunRow {
  return {
    checkpoint_version: numberBinding(bindings[8]),
    created_at: numberBinding(bindings[9]),
    dedupe_key: nullableStringBinding(bindings[3]),
    parent_run_id: nullableStringBinding(bindings[4]),
    prefix: stringBinding(bindings[0]),
    record: stringBinding(bindings[2]),
    root_run_id: stringBinding(bindings[5]),
    run_id: stringBinding(bindings[1]),
    status: stringBinding(bindings[7]),
    thread_key: stringBinding(bindings[6]),
    updated_at: numberBinding(bindings[10]),
  };
}
