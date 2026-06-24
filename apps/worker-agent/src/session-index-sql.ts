import type { SqlStorage } from "@minpeter/pss-runtime/cloudflare";

import { ChannelAddressSchema } from "./channel";
import type {
  SessionIndexRecord,
  SessionIndexRepository,
} from "./session-index";

const TABLE_NAME = "pss_worker_session_index";

interface SessionIndexRow {
  readonly channel_id: string;
  readonly channel_kind: string;
  readonly conversation_key: string;
  readonly last_seen_at: number;
  readonly recent_assistant_text: string;
  readonly recent_user_text: string;
  readonly turn_count: number;
}

export function createSqlSessionIndexRepository(
  sqlStorage: unknown
): SessionIndexRepository {
  const sql = sqlStorage as SqlStorage;
  let schemaReady = false;
  const ensureSchema = (): void => {
    if (schemaReady) {
      return;
    }
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        conversation_key TEXT PRIMARY KEY,
        channel_kind TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        turn_count INTEGER NOT NULL,
        recent_user_text TEXT NOT NULL,
        recent_assistant_text TEXT NOT NULL
      )`
    );
    schemaReady = true;
  };

  return {
    all: () => {
      ensureSchema();
      const rows = sql
        .exec<SessionIndexRow>(
          `SELECT conversation_key, channel_kind, channel_id, last_seen_at, turn_count, recent_user_text, recent_assistant_text FROM ${TABLE_NAME}`
        )
        .toArray();
      return Promise.resolve(rows.map(toRecord));
    },
    get: (key) => {
      ensureSchema();
      const [row] = sql
        .exec<SessionIndexRow>(
          `SELECT conversation_key, channel_kind, channel_id, last_seen_at, turn_count, recent_user_text, recent_assistant_text FROM ${TABLE_NAME} WHERE conversation_key = ?`,
          key
        )
        .toArray();
      return Promise.resolve(row ? toRecord(row) : undefined);
    },
    put: (record) => {
      ensureSchema();
      sql.exec(
        `INSERT INTO ${TABLE_NAME} (conversation_key, channel_kind, channel_id, last_seen_at, turn_count, recent_user_text, recent_assistant_text)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_key) DO UPDATE SET
           channel_kind = excluded.channel_kind,
           channel_id = excluded.channel_id,
           last_seen_at = excluded.last_seen_at,
           turn_count = excluded.turn_count,
           recent_user_text = excluded.recent_user_text,
           recent_assistant_text = excluded.recent_assistant_text`,
        record.conversationKey,
        record.channelKind,
        record.channelId,
        record.lastSeenAt,
        record.turnCount,
        JSON.stringify(record.recentUserText),
        JSON.stringify(record.recentAssistantText)
      );
      return Promise.resolve();
    },
  };
}

function toRecord(row: SessionIndexRow): SessionIndexRecord {
  return {
    channelId: row.channel_id,
    channelKind: ChannelAddressSchema.shape.kind.parse(row.channel_kind),
    conversationKey: row.conversation_key,
    lastSeenAt: Number(row.last_seen_at),
    recentAssistantText: parseStringArray(row.recent_assistant_text),
    recentUserText: parseStringArray(row.recent_user_text),
    turnCount: Number(row.turn_count),
  };
}

function parseStringArray(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}
