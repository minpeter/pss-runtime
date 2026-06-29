import { describe, expect, it } from "vitest";
import { userText } from "../../testing/test-fixtures";
import {
  SpyStore as BaseSpyStore,
  type SpyStore,
} from "../handle/test-support";
import type {
  CommitResult,
  StoredThread,
  ThreadStoreCommit,
} from "../store/types";
import { ThreadState } from "./thread-state";

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
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    this.commitStarted.resolve();
    await this.allowCommit.promise;
    return super.commit(key, next, options);
  }
}

describe("ThreadState deletion", () => {
  it("keeps in-memory state usable when persistence deletion fails", async () => {
    const store = new RejectingDeleteStore();
    const state = new ThreadState({ key: "delete-failure", store });

    state.appendUserInput(userText("before"));
    await state.commit();

    await expect(state.delete()).rejects.toThrow("delete failed");

    state.appendUserInput(userText("after"));
    await state.commit();

    expect(store.commits).toHaveLength(2);
  });

  it("does not resurrect a thread when delete wins a commit race", async () => {
    const store = new DelayedCommitStore();
    const state = new ThreadState({ key: "race", store });

    state.appendUserInput(userText("before"));
    const commit = state.commit();
    await store.commitStarted.promise;
    const deletion = state.delete();

    store.allowCommit.resolve();
    await Promise.all([commit, deletion]);

    expect(loadStored(store, "race")).toBeNull();
  });
});

function loadStored(store: SpyStore, key: string): StoredThread | null {
  return store.threads.get(key) ?? null;
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
