type ChildSessionCleanup = () => Promise<void>;

export class ChildSessionCleanups {
  readonly #byParentSession = new Map<string, Set<ChildSessionCleanup>>();

  async delete(parentSessionKey: string): Promise<void> {
    const cleanups = this.#byParentSession.get(parentSessionKey);
    if (!cleanups) {
      return;
    }

    this.#byParentSession.delete(parentSessionKey);
    await Promise.all([...cleanups].map((cleanup) => cleanup()));
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
}
