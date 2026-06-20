import { numberBinding, stringBinding } from "./bindings";
import type {
  CheckpointRow,
  EventRow,
  InMemoryDurableObjectSqlState,
  NotificationRow,
  PayloadChunkRow,
  RunRow,
  ScheduledWorkRow,
  ThreadMessageChunkRow,
  ThreadMessageRow,
  ThreadMetaRow,
} from "./state";

export function selectSqlRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  if (query.includes("from sqlite_master")) {
    return [];
  }
  if (query.includes("from pss_thread_meta")) {
    return selectThreadMetaRows(state, query, bindings);
  }
  if (query.includes("from pss_thread_message_chunk")) {
    return selectThreadMessageChunkRows(state, bindings);
  }
  if (query.includes("from pss_thread_message")) {
    return selectThreadMessageRows(state, query, bindings);
  }
  if (query.includes("from pss_run")) {
    return selectRunRows(state, query, bindings);
  }
  if (query.includes("from pss_notification")) {
    return selectNotificationRows(state, query, bindings);
  }
  if (query.includes("from pss_payload_chunk")) {
    return selectPayloadChunkRows(state, query, bindings);
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
  if (query.includes("from pss_scheduled_work")) {
    return selectScheduledWorkRows(state, query, bindings);
  }
  throw new Error(`Unsupported in-memory Durable Object SQL query: ${query}`);
}

function selectPayloadChunkRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const scope = stringBinding(bindings[0]);
  const ownerKey = stringBinding(bindings[1]);
  const payloadKeys = query.includes("payload_key in")
    ? new Set(bindings.slice(2).map(stringBinding))
    : new Set([stringBinding(bindings[2])]);
  return state.payloadChunks
    .filter(
      (row) =>
        row.scope === scope &&
        row.owner_key === ownerKey &&
        payloadKeys.has(row.payload_key)
    )
    .sort(
      (left: PayloadChunkRow, right: PayloadChunkRow) =>
        left.payload_key.localeCompare(right.payload_key) ||
        left.chunk_index - right.chunk_index
    )
    .map((row) => projectPayloadChunk(row, query));
}

function selectThreadMetaRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  if (query.includes("where thread_key = ?")) {
    const key = stringBinding(bindings[0]);
    const row = state.threadMeta.get(key);
    return row ? [projectThreadMeta(row, query)] : [];
  }
  if (query === "select thread_key from pss_thread_meta") {
    return [...state.threadMeta.keys()].map((thread_key) => ({
      thread_key,
    }));
  }
  throw new Error(`Unsupported in-memory thread meta SQL query: ${query}`);
}

function selectThreadMessageRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const rows = state.threadMessages.filter((row) => {
    if (row.thread_key !== key) {
      return false;
    }
    return query.includes("active = 1") ? row.active === 1 : true;
  });
  return rows
    .sort(
      (left: ThreadMessageRow, right: ThreadMessageRow) => left.seq - right.seq
    )
    .map((row) => projectThreadMessage(row, query));
}

function selectThreadMessageChunkRows(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): unknown[] {
  const key = stringBinding(bindings[0]);
  const seqs = new Set(bindings.slice(1).map(numberBinding));
  return state.threadMessageChunks
    .filter((row) => row.thread_key === key && seqs.has(row.seq))
    .sort(
      (left: ThreadMessageChunkRow, right: ThreadMessageChunkRow) =>
        left.seq - right.seq || left.chunk_index - right.chunk_index
    )
    .map((row) => ({
      chunk: row.chunk,
      chunk_index: row.chunk_index,
      seq: row.seq,
    }));
}

function selectRunRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const prefix = stringBinding(bindings[0]);
  if (query.includes("run_id = ?")) {
    const runId = stringBinding(bindings[1]);
    return state.turns
      .filter((row) => row.prefix === prefix && row.run_id === runId)
      .map(projectRun);
  }
  if (query.includes("dedupe_key = ?")) {
    const dedupeKey = stringBinding(bindings[1]);
    return state.turns
      .filter((row) => row.prefix === prefix && row.dedupe_key === dedupeKey)
      .map(projectRun)
      .slice(0, 1);
  }
  if (query.includes("parent_run_id = ?")) {
    const parentRunId = stringBinding(bindings[1]);
    return state.turns
      .filter(
        (row) => row.prefix === prefix && row.parent_run_id === parentRunId
      )
      .sort((left: RunRow, right: RunRow) => left.created_at - right.created_at)
      .map(projectRun);
  }
  throw new Error(`Unsupported in-memory run SQL query: ${query}`);
}

function selectNotificationRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const prefix = stringBinding(bindings[0]);
  if (query.includes("idempotency_key = ?")) {
    const idempotencyKey = stringBinding(bindings[1]);
    return state.notifications
      .filter(
        (row) => row.prefix === prefix && row.idempotency_key === idempotencyKey
      )
      .map(projectNotification)
      .slice(0, 1);
  }
  throw new Error(`Unsupported in-memory notification SQL query: ${query}`);
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

function selectScheduledWorkRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const prefix = stringBinding(bindings[0]);
  const kind = stringBinding(bindings[1]);
  const workId = query.includes("work_id = ?")
    ? stringBinding(bindings[2])
    : undefined;
  const limit = query.includes("limit ?")
    ? numberBinding(bindings[workId === undefined ? 2 : 3])
    : undefined;
  const rows = state.scheduledWork
    .filter(
      (row) =>
        row.prefix === prefix &&
        row.kind === kind &&
        (workId === undefined || row.work_id === workId)
    )
    .sort(
      (left: ScheduledWorkRow, right: ScheduledWorkRow) =>
        left.created_at - right.created_at
    );

  return rows.slice(0, limit).map((row) => {
    if (query.startsWith("select work_id from")) {
      return { work_id: row.work_id };
    }
    return {
      payload: row.payload,
      run_id: row.run_id,
      thread_key: row.thread_key,
      work_id: row.work_id,
    };
  });
}

function projectThreadMeta(row: ThreadMetaRow, query: string): unknown {
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

function projectThreadMessage(row: ThreadMessageRow, query: string): unknown {
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

function projectRun(row: RunRow): unknown {
  return { record: row.record };
}

function projectNotification(row: NotificationRow): unknown {
  return { record: row.record };
}

function projectPayloadChunk(row: PayloadChunkRow, query: string): unknown {
  const projected: Record<string, unknown> = {
    chunk: row.chunk,
    chunk_index: row.chunk_index,
  };
  if (query.includes("payload_key")) {
    projected.payload_key = row.payload_key;
  }
  return projected;
}
