import type {
  AdmitReceipt,
  ClaimedThreadInput,
  ThreadInputInbox,
  ThreadInputRecord,
} from "./types";

export class ThreadInputInboxUnavailableError extends Error {
  readonly name = "ThreadInputInboxUnavailableError";

  constructor() {
    super("ThreadInputInbox is not implemented for this execution store.");
  }
}

export class UnsupportedThreadInputInbox implements ThreadInputInbox {
  admit(): Promise<AdmitReceipt> {
    return Promise.reject(new ThreadInputInboxUnavailableError());
  }

  claimNext(): Promise<ClaimedThreadInput | null> {
    return Promise.reject(new ThreadInputInboxUnavailableError());
  }

  releaseClaim(): Promise<ThreadInputRecord | null> {
    return Promise.reject(new ThreadInputInboxUnavailableError());
  }

  markPromoted(): Promise<ThreadInputRecord | null> {
    return Promise.reject(new ThreadInputInboxUnavailableError());
  }

  ack(): Promise<ThreadInputRecord | null> {
    return Promise.reject(new ThreadInputInboxUnavailableError());
  }
}
