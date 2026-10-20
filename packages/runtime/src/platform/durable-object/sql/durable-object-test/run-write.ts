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
    deleteRun(state, query, bindings);
    return true;
  }
  return false;
}

function upsertRun(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const row = createRunRow(bindings);
  // Mirrors `ON CONFLICT DO UPDATE`: the row keeps its created_at and rowid
  // position, which thread listings order by.
  const index = state.turns.findIndex(
    (existing) =>
      existing.prefix === row.prefix && existing.run_id === row.run_id
  );
  const existing = state.turns[index];
  if (existing === undefined) {
    state.turns.push(row);
    return;
  }
  state.turns[index] = { ...row, created_at: existing.created_at };
}

function deleteRun(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[0]);
  const value = stringBinding(bindings[1]);
  state.turns = state.turns.filter(
    (row) =>
      !(
        row.prefix === prefix &&
        (query.includes("thread_key = ?")
          ? row.thread_key === value
          : row.run_id === value)
      )
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
