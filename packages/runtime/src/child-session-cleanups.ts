type ChildSessionCleanup = () => Promise<void>;

type CleanupResult =
  | { readonly cleanup: ChildSessionCleanup; readonly ok: true }
  | {
      readonly cleanup: ChildSessionCleanup;
      readonly error: unknown;
      readonly ok: false;
    };

export class ChildSessionCleanups {
  readonly #byParentSession = new Map<string, Set<ChildSessionCleanup>>();

  async delete(parentSessionKey: string): Promise<void> {
    const cleanups = this.#byParentSession.get(parentSessionKey);
    if (!cleanups) {
      return;
    }

    this.#byParentSession.delete(parentSessionKey);
    const results = await Promise.all([...cleanups].map(runCleanup));
    const failedCleanups: ChildSessionCleanup[] = [];
    let firstError: unknown;
    for (const result of results) {
      if (result.ok) {
        continue;
      }

      firstError ??= result.error;
      failedCleanups.push(result.cleanup);
    }

    if (failedCleanups.length === 0) {
      return;
    }

    this.#restore(parentSessionKey, failedCleanups);
    throw firstError instanceof Error
      ? firstError
      : new Error(String(firstError));
  }

  register(parentSessionKey: string, cleanup: ChildSessionCleanup): () => void {
    const existing = this.#byParentSession.get(parentSessionKey);
    if (existing) {
      existing.add(cleanup);
      return () => this.#unregister(parentSessionKey, existing, cleanup);
    }

    const cleanups = new Set([cleanup]);
    this.#byParentSession.set(parentSessionKey, cleanups);
    return () => this.#unregister(parentSessionKey, cleanups, cleanup);
  }

  #unregister(
    parentSessionKey: string,
    cleanups: Set<ChildSessionCleanup>,
    cleanup: ChildSessionCleanup
  ): void {
    cleanups.delete(cleanup);
    if (
      cleanups.size === 0 &&
      this.#byParentSession.get(parentSessionKey) === cleanups
    ) {
      this.#byParentSession.delete(parentSessionKey);
    }
  }

  #restore(
    parentSessionKey: string,
    failedCleanups: readonly ChildSessionCleanup[]
  ): void {
    const current = this.#byParentSession.get(parentSessionKey);
    if (current) {
      for (const cleanup of failedCleanups) {
        current.add(cleanup);
      }
      return;
    }

    this.#byParentSession.set(parentSessionKey, new Set(failedCleanups));
  }
}

async function runCleanup(
  cleanup: ChildSessionCleanup
): Promise<CleanupResult> {
  try {
    await cleanup();
    return { cleanup, ok: true };
  } catch (error) {
    return { cleanup, error, ok: false };
  }
}
