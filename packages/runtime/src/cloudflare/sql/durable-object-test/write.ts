import {
  nullableStringBinding,
  numberBinding,
  stringBinding,
} from "./bindings";
import { writeNotificationStatement } from "./notification-write";
import { writeRunStatement } from "./run-write";
import type { InMemoryDurableObjectSqlState, ThreadMetaRow } from "./state";

export function writeSqlStatement(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  if (query.includes("pss_thread_")) {
    writeThreadStatement(state, query, bindings);
    return;
  }
  if (writeRunStatement(state, query, bindings)) {
    return;
  }
  if (writeNotificationStatement(state, query, bindings)) {
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
  if (query.startsWith("insert into pss_scheduled_work")) {
    writeScheduledWork(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_scheduled_work")) {
    deleteScheduledWork(state, bindings);
    return;
  }
  throw new Error(
    `Unsupported in-memory Durable Object SQL statement: ${query}`
  );
}

function writeThreadStatement(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  if (query.startsWith("delete from pss_thread_message")) {
    deleteThreadMessages(state, bindings);
    return;
  }
  if (query.startsWith("delete from pss_thread_meta")) {
    state.threadMeta.delete(stringBinding(bindings[0]));
    return;
  }
  if (query.startsWith("update pss_thread_message set active = 0")) {
    deactivateThreadMessages(state, query, bindings);
    return;
  }
  if (query.startsWith("insert into pss_thread_message")) {
    insertThreadMessage(state, query, bindings);
    return;
  }
  if (query.startsWith("insert into pss_thread_meta")) {
    insertThreadMeta(state, bindings);
    return;
  }
  throw new Error(`Unsupported in-memory thread SQL statement: ${query}`);
}

function deleteThreadMessages(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.threadMessages = state.threadMessages.filter(
    (row) => row.thread_key !== key
  );
}

function deactivateThreadMessages(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  const minSeq = query.includes("seq >= ?")
    ? numberBinding(bindings[1])
    : Number.NEGATIVE_INFINITY;
  for (const row of state.threadMessages) {
    if (row.thread_key === key && row.active === 1 && row.seq >= minSeq) {
      row.active = 0;
    }
  }
}

function insertThreadMessage(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  const hasImplicitSeq = query.includes("values (?, 0, 1, ?)");
  state.threadMessages.push({
    active: 1,
    message: stringBinding(hasImplicitSeq ? bindings[1] : bindings[2]),
    seq: hasImplicitSeq ? 0 : numberBinding(bindings[1]),
    thread_key: stringBinding(bindings[0]),
  });
}

function insertThreadMeta(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const key = stringBinding(bindings[0]);
  state.threadMeta.set(key, createThreadMetaRow(key, bindings));
}

function createThreadMetaRow(
  key: string,
  bindings: readonly unknown[]
): ThreadMetaRow {
  if (bindings.length >= 5) {
    return {
      message_count: numberBinding(bindings[2]),
      next_seq: numberBinding(bindings[3]),
      state_blob: nullableStringBinding(bindings[4]),
      thread_key: key,
      version: stringBinding(bindings[1]),
    };
  }
  return {
    message_count: 1,
    next_seq: 1,
    state_blob: null,
    thread_key: key,
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

function writeScheduledWork(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[0]);
  const kind = stringBinding(bindings[1]);
  const workId = stringBinding(bindings[2]);
  state.scheduledWork = state.scheduledWork.filter(
    (row) =>
      !(row.prefix === prefix && row.kind === kind && row.work_id === workId)
  );
  state.scheduledWork.push({
    created_at: numberBinding(bindings[6]),
    kind,
    payload: stringBinding(bindings[3]),
    prefix,
    run_id: nullableStringBinding(bindings[5]),
    thread_key: nullableStringBinding(bindings[4]),
    work_id: workId,
  });
}

function deleteScheduledWork(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[0]);
  const kind = stringBinding(bindings[1]);
  const workId = stringBinding(bindings[2]);
  state.scheduledWork = state.scheduledWork.filter(
    (row) =>
      !(row.prefix === prefix && row.kind === kind && row.work_id === workId)
  );
}
