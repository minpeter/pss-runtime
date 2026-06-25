import { createNodeFileThreadHost } from "@minpeter/pss-runtime/platform/node";

interface ProbeState {
  readonly history: readonly string[];
}

const directory = process.env.PSS_EXAMPLE_THREAD_DIR ?? ".pss-local-threads";
const threadKey = process.env.PSS_EXAMPLE_THREAD_KEY ?? "probe";
const mode =
  process.argv[2] === "--"
    ? (process.argv[3] ?? "write")
    : (process.argv[2] ?? "write");
const host = createNodeFileThreadHost({ directory });
const loaded = await host.threadStore.load(threadKey);
const history = readHistory(loaded?.state);

if (mode === "write") {
  const nextHistory = [
    ...history,
    `probe-write-${String(history.length + 1).padStart(2, "0")}`,
  ];
  const result = await host.threadStore.commit(
    threadKey,
    { state: { history: nextHistory } satisfies ProbeState },
    { expectedVersion: loaded?.version ?? null }
  );
  console.log(
    JSON.stringify({
      directory,
      historyLength: nextHistory.length,
      mode,
      ok: result.ok,
      threadKey,
      version: result.ok ? result.version : loaded?.version,
    })
  );
} else if (mode === "read") {
  console.log(
    JSON.stringify({
      directory,
      history,
      historyLength: history.length,
      mode,
      threadKey,
      version: loaded?.version ?? null,
    })
  );
} else {
  throw new Error(`Unsupported probe mode: ${mode}`);
}

function readHistory(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }
  const history = value.history;
  if (!Array.isArray(history)) {
    return [];
  }
  return history.filter((item) => typeof item === "string");
}

function isRecord(
  value: unknown
): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object";
}
