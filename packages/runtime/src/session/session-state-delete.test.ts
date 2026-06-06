import { describe, expect, it } from "vitest";
import { userText } from "../test-fixtures";
import {
  SpyStore as BaseSpyStore,
  type SpyStore,
} from "./session.test-support";
import { SessionState } from "./session-state";
import type {
  CommitResult,
  SessionStoreCommit,
  StoredSession,
} from "./store/types";

class RejectingDeleteStore extends BaseSpyStore {
  override delete(_key: string): Promise<void> {
    return Promise.reject(new Error("delete failed"));
  }
}

class DelayedCommitStore extends BaseSpyStore {
  readonly commitStarted = createDeferred<void>();
  readonly allowCommit = createDeferred<void>();

  override async commit(
    key: string,
    next: SessionStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    this.commitStarted.resolve();
    await this.allowCommit.promise;
    return super.commit(key, next, options);
  }
}

describe("SessionState deletion", () => {
  it("keeps in-memory state usable when persistence deletion fails", async () => {
    const store = new RejectingDeleteStore();
    const state = new SessionState({ key: "delete-failure", store });

    state.appendUserInput(userText("before"));
    await state.commit();

    await expect(state.delete()).rejects.toThrow("delete failed");

    state.appendUserInput(userText("after"));
    await state.commit();

    expect(store.commits).toHaveLength(2);
  });

  it("does not resurrect a session when delete wins a commit race", async () => {
    const store = new DelayedCommitStore();
    const state = new SessionState({ key: "race", store });

    state.appendUserInput(userText("before"));
    const commit = state.commit();
    await store.commitStarted.promise;
    const deletion = state.delete();

    store.allowCommit.resolve();
    await Promise.all([commit, deletion]);

    expect(loadStored(store, "race")).toBeNull();
  });
});

function loadStored(store: SpyStore, key: string): StoredSession | null {
  return store.sessions.get(key) ?? null;
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
