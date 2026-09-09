import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const FAKE_TOKEN = "123456789:FAKE_RECORDER_SENTINEL_NOT_A_CREDENTIAL";

it("records method/path evidence without Telegram credentials or payload content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loopback-recorder-"));
  const logPath = join(directory, "nested", "requests.jsonl");
  const child = fork(
    fileURLToPath(
      new URL("./loopback-recorder.test-support.mjs", import.meta.url)
    ),
    ["--port", "8793", "--log", logPath],
    { execArgv: [], silent: true }
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const closed = once(child, "close", { signal: AbortSignal.timeout(10_000) });
  try {
    const ready = once(child, "message", { signal: AbortSignal.timeout(5000) });
    child.send("start");
    const [{ address, requestedPort }] = await ready;
    expect(requestedPort).toBe(8793);
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${address.port}`;
    const requests = [
      { method: "POST", path: `/bot${FAKE_TOKEN}/getMe` },
      {
        method: "POST",
        path: `/bot${FAKE_TOKEN}/sendMessage?token=${FAKE_TOKEN}`,
        body: JSON.stringify({ chat_id: 1, text: FAKE_TOKEN }),
      },
      { method: "GET", path: `/file/bot${FAKE_TOKEN}/photos/file.jpg` },
      { method: "POST", path: `/bot${encodeURIComponent(FAKE_TOKEN)}/getMe` },
      {
        method: "POST",
        path: "/v1/chat/completions",
        body: JSON.stringify({ prompt: FAKE_TOKEN }),
      },
      { method: "GET", path: `/probe?token=${encodeURIComponent(FAKE_TOKEN)}` },
    ];
    for (const { method, path, body } of requests) {
      const response = await fetch(`${base}${path}`, {
        method,
        body,
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toMatchObject({
        ok: true,
        result: { id: 0, is_bot: true, message_id: 1 },
      });
    }
    // The response is sent only after the synchronous JSONL append finishes.
    const evidence = await readFile(logPath, "utf8");
    expect(evidence).not.toContain(FAKE_TOKEN);
    expect(evidence).not.toContain(encodeURIComponent(FAKE_TOKEN));
    const entries = evidence.trimEnd().split("\n").map(JSON.parse);
    expect(entries.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: "/bot[REDACTED]/getMe" },
      { method: "POST", url: "/bot[REDACTED]/sendMessage" },
      { method: "GET", url: "/file/bot[REDACTED]/photos/file.jpg" },
      { method: "POST", url: "/bot[REDACTED]/getMe" },
      { method: "POST", url: "/v1/chat/completions" },
      { method: "GET", url: "/probe" },
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["method", "ts", "url"]);
      expect(Number.isFinite(Date.parse(entry.ts))).toBe(true);
    }
  } finally {
    child.kill("SIGKILL");
    await closed;
    await rm(directory, { force: true, recursive: true });
  }
  expect(output).not.toContain(FAKE_TOKEN);
});
