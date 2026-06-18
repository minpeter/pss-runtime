import {
  nullableStringBinding,
  numberBinding,
  stringBinding,
} from "./in-memory-durable-object-sql-bindings";
import type {
  InMemoryDurableObjectSqlState,
  SessionMetaRow,
} from "./in-memory-durable-object-sql-state";

export function writeSqlStatement(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  if (query.includes("pss_session_")) {
    writeSessionStatement(state, query, bindings);
    return;
  }
  if (query.startsWith("insert into pss_event_meta")) {
    writeEventMeta(state, bindings);
    return;
  }
  if (query.startsWith("insert into pss_event")) {
    writeEvent(state, bindings);
    return;
  }
  if (query.startsWith("insert into pss_checkpoint")) {
    writeCheckpoint(state, bindings);
    return;
  }
  throw new Error(
    `Unsupported in-memory Durable Object SQL statement: ${query}`
  );
}

function writeSessionStatement(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  if (query.startsWith("delete from pss_session_message")) {
    deleteSessionMessages(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_session_meta")) {
    state.sessionMeta.delete(stringBinding(bindings[0]));
    return;
  }
  if (query.startsWith("update pss_session_message set active = 0")) {
    deactivateSessionMessages(state, query, bindings);
    return;
  }
  if (query.startsWith("insert into pss_session_message")) {
    insertSessionMessage(state, query, bindings);
    return;
  }
  if (query.startsWith("insert into pss_session_meta")) {
    insertSessionMeta(state, bindings);
    return;
  }
  throw new Error(`Unsupported in-memory session SQL statement: ${query}`);
}

function deleteSessionMessages(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.sessionMessages = state.sessionMessages.filter(
    (row) => row.session_key !== key
  );
}

function deactivateSessionMessages(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  const minSeq = query.includes("seq >= ?")
    ? numberBinding(bindings[1])
    : Number.NEGATIVE_INFINITY;
  for (const row of state.sessionMessages) {
    if (row.session_key === key && row.active === 1 && row.seq >= minSeq) {
      row.active = 0;
    }
  }
}

function insertSessionMessage(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  const hasImplicitSeq = query.includes("values (?, 0, 1, ?)");
  state.sessionMessages.push({
    active: 1,
    message: stringBinding(hasImplicitSeq ? bindings[1] : bindings[2]),
    seq: hasImplicitSeq ? 0 : numberBinding(bindings[1]),
    session_key: stringBinding(bindings[0]),
  });
}

function insertSessionMeta(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.sessionMeta.set(key, createSessionMetaRow(key, bindings));
}

function createSessionMetaRow(
  key: string,
  bindings: readonly unknown[]
): SessionMetaRow {
  if (bindings.length >= 5) {
    return {
      message_count: numberBinding(bindings[2]),
      next_seq: numberBinding(bindings[3]),
      session_key: key,
      state_blob: nullableStringBinding(bindings[4]),
      version: stringBinding(bindings[1]),
    };
  }
  return {
    message_count: 1,
    next_seq: 1,
    session_key: key,
    state_blob: null,
    version: 1,
  };
}

function writeEventMeta(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.eventMeta.set(key, {
    next_seq: numberBinding(bindings[1]),
    run_key: key,
  });
}

function writeEvent(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  state.events.push({
    event: stringBinding(bindings[2]),
    run_key: stringBinding(bindings[0]),
    seq: numberBinding(bindings[1]),
  });
}

function writeCheckpoint(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const runKey = stringBinding(bindings[0]);
  const version = numberBinding(bindings[1]);
  state.checkpoints = state.checkpoints.filter(
    (row) => !(row.run_key === runKey && row.version === version)
  );
  state.checkpoints.push({
    checkpoint: stringBinding(bindings[2]),
    run_key: runKey,
    version,
  });
}
