import { numberBinding, stringBinding } from "./bindings";
import type {
  CheckpointRow,
  EventRow,
  InMemoryDurableObjectSqlState,
  SessionMessageRow,
  SessionMetaRow,
} from "./state";

export function selectSqlRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  if (query.includes("from pss_session_meta")) {
    return selectSessionMetaRows(state, query, bindings);
  }
  if (query.includes("from pss_session_message")) {
    return selectSessionMessageRows(state, query, bindings);
  }
  if (query.includes("from pss_event_meta")) {
    return selectEventMetaRows(state, bindings);
  }
  if (query.includes("from pss_event")) {
    return selectEventRows(state, query, bindings);
  }
  if (query.includes("from pss_checkpoint")) {
    return selectCheckpointRows(state, query, bindings);
  }
  throw new Error(`Unsupported in-memory Durable Object SQL query: ${query}`);
}

function selectSessionMetaRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  if (query.includes("where session_key = ?")) {
    const key = stringBinding(bindings[0]);
    const row = state.sessionMeta.get(key);
    return row ? [projectSessionMeta(row, query)] : [];
  }
  if (query === "select session_key from pss_session_meta") {
    return [...state.sessionMeta.keys()].map((session_key) => ({
      session_key,
    }));
  }
  throw new Error(`Unsupported in-memory session meta SQL query: ${query}`);
}

function selectSessionMessageRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const rows = state.sessionMessages.filter((row) => {
    if (row.session_key !== key) {
      return false;
    }
    return query.includes("active = 1") ? row.active === 1 : true;
  });
  return rows
    .sort(
      (left: SessionMessageRow, right: SessionMessageRow) =>
        left.seq - right.seq
    )
    .map((row) => projectSessionMessage(row, query));
}

function selectEventMetaRows(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const row = state.eventMeta.get(key);
  return row ? [{ next_seq: row.next_seq }] : [];
}

function selectEventRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const start = query.includes("seq >= ?") ? numberBinding(bindings[1]) : 0;
  return [...state.events]
    .filter((row) => row.run_key === key && row.seq >= start)
    .sort((left: EventRow, right: EventRow) => left.seq - right.seq)
    .map((row: EventRow) => ({ event: row.event, seq: row.seq }));
}

function selectCheckpointRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const rows = state.checkpoints.filter((row) => row.run_key === key);
  if (query.includes("order by version desc limit 1")) {
    const latest = [...rows].sort(
      (left: CheckpointRow, right: CheckpointRow) =>
        right.version - left.version
    )[0];
    return latest
      ? [{ checkpoint: latest.checkpoint, version: latest.version }]
      : [];
  }
  return [...rows]
    .sort(
      (left: CheckpointRow, right: CheckpointRow) =>
        left.version - right.version
    )
    .map((row: CheckpointRow) => ({
      checkpoint: row.checkpoint,
      version: row.version,
    }));
}

function projectSessionMeta(row: SessionMetaRow, query: string): unknown {
  if (query.startsWith("select version, message_count, next_seq, state_blob")) {
    return {
      message_count: row.message_count,
      next_seq: row.next_seq,
      state_blob: row.state_blob,
      version: row.version,
    };
  }
  return structuredClone(row);
}

function projectSessionMessage(row: SessionMessageRow, query: string): unknown {
  const projected: Record<string, unknown> = {};
  if (query.includes("seq")) {
    projected.seq = row.seq;
  }
  if (query.includes("active")) {
    projected.active = row.active;
  }
  if (query.includes("message")) {
    projected.message = row.message;
  }
  return projected;
}
