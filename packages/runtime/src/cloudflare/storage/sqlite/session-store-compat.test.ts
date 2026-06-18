import { describe, expect, it } from "vitest";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";
import { DurableObjectSqliteSessionStore } from "./session-store";
import { PREFIX, snapshot } from "./session-store.test-support";

describe("DurableObjectSqliteSessionStore compatibility", () => {
  it("normalizes a numeric meta version for the optimistic compare", async () => {
    const sql = new InMemorySqlStorage();
    const storage = new InMemoryCloudflareDurableObjectStorage({ sql });
    const key = storeKey(PREFIX, "session", "num");
    sql.exec(
      "CREATE TABLE pss_session_meta (session_key TEXT PRIMARY KEY, version INTEGER NOT NULL, message_count INTEGER NOT NULL, next_seq INTEGER NOT NULL, state_blob TEXT)"
    );
    sql.exec(
      "CREATE TABLE pss_session_message (session_key TEXT NOT NULL, seq INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, message TEXT NOT NULL, PRIMARY KEY (session_key, seq))"
    );
    sql.exec(
      "INSERT INTO pss_session_message (session_key, seq, active, message) VALUES (?, 0, 1, ?)",
      key,
      JSON.stringify({ i: 0 })
    );
    sql.exec(
      "INSERT INTO pss_session_meta (session_key, version, message_count, next_seq, state_blob) VALUES (?, 1, 1, 1, NULL)",
      key
    );

    const store = new DurableObjectSqliteSessionStore(storage, PREFIX);
    await expect(store.load("num")).resolves.toEqual({
      state: { history: [{ i: 0 }], schemaVersion: 1 },
      version: "1",
    });
    await expect(
      store.commit("num", snapshot([{ i: 0 }, { i: 1 }]), {
        expectedVersion: "1",
      })
    ).resolves.toEqual({ ok: true, version: "2" });
  });
});
