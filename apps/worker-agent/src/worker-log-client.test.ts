import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  initLogger: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("evlog", () => ({
  EvlogError: class EvlogError extends Error {},
  initLogger: hoisted.initLogger,
  log: hoisted.log,
}));

describe("ensureWorkerLogger", () => {
  beforeEach(() => {
    // ensureWorkerLogger is idempotent per module instance; reset modules so
    // each test observes a fresh initialization.
    vi.resetModules();
    hoisted.initLogger.mockClear();
  });

  it("initializes evlog with redaction enabled (redact: true)", async () => {
    const { ensureWorkerLogger } = await import("./worker-log-client");
    ensureWorkerLogger({ environment: "development" });
    expect(hoisted.initLogger).toHaveBeenCalledTimes(1);
    expect(hoisted.initLogger).toHaveBeenCalledWith(
      expect.objectContaining({ redact: true })
    );
  });

  it("redaction stays enabled for production environments too", async () => {
    const { ensureWorkerLogger } = await import("./worker-log-client");
    ensureWorkerLogger({ environment: "production" });
    expect(hoisted.initLogger).toHaveBeenCalledWith(
      expect.objectContaining({ pretty: false, redact: true })
    );
  });

  it("is idempotent: a second call does not re-initialize", async () => {
    const { ensureWorkerLogger } = await import("./worker-log-client");
    ensureWorkerLogger({ environment: "development" });
    ensureWorkerLogger({ environment: "production" });
    expect(hoisted.initLogger).toHaveBeenCalledTimes(1);
  });

  it("tags the service and environment on the logger env", async () => {
    const { ensureWorkerLogger } = await import("./worker-log-client");
    ensureWorkerLogger({ environment: "development", version: "v1" });
    expect(hoisted.initLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          service: "pss-worker-agent",
          environment: "development",
          version: "v1",
        },
      })
    );
  });
});
