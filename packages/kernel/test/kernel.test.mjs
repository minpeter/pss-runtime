import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { unstable_dev } from "wrangler";

let worker;

beforeAll(async () => {
  worker = await unstable_dev("src/index.ts", {
    config: "wrangler.jsonc",
    local: true,
    port: 0,
    inspectorPort: 0,
    persist: false,
    logLevel: "error",
    experimental: { disableExperimentalWarning: true },
  });
});

afterAll(async () => {
  await worker?.stop();
});

function execute(session, code) {
  return worker.fetch(`/sessions/${session}/eval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

test("serves a landing response at the root route", async () => {
  // Given: the local Worker is running.
  // When: a browser requests the base URL.
  const response = await worker.fetch("/");
  const body = await response.json();
  // Then: the PoC advertises its available endpoints instead of returning 404.
  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    name: "pss-kernel",
    endpoints: { health: "/health" },
  });
});

test("composes dependent async tool calls in one eval request", async () => {
  // Given: a new session and one model-generated program.
  const session = randomUUID();
  const code = `(async () => {
    const products = await tools.catalog.search({ query: "keyboard" });
    const quotes = await Promise.all(products.map(product =>
      tools.pricing.quote({ sku: product.sku, quantity: 2 })
    ));
    const cheapest = quotes.toSorted((a, b) => a.totalCents - b.totalCents)[0];
    globalThis.lastQuote = cheapest;
    return await tools.notes.save({ key: "recommendation", value: cheapest });
  })()`;

  // When: the client submits the entire program once.
  const response = await execute(session, code);
  const result = await response.json();

  // Then: host tools ran and their dependent result was saved without client round trips.
  expect(response.status).toBe(200);
  expect(result).toMatchObject({
    status: "ok",
    result: {
      key: "recommendation",
      value: { sku: "kbd-basic", quantity: 2, totalCents: 8000 },
    },
    calls: [
      { tool: "catalog.search", status: "ok" },
      { tool: "pricing.quote", status: "ok" },
      { tool: "pricing.quote", status: "ok" },
      { tool: "notes.save", status: "ok" },
    ],
  });
});

test("retains global lexical bindings between cells", async () => {
  // Given: declarations evaluated in a live session.
  const session = randomUUID();
  const first = await execute(
    session,
    "const base = 40; let offset = 2; var runs = 1;"
  );
  await first.json();
  // When: another request reads the same bindings.
  const result = await (
    await execute(session, "({answer: base + offset, runs})")
  ).json();
  // Then: values survive across requests, including lexical declarations.
  expect(result).toMatchObject({
    status: "ok",
    result: { answer: 42, runs: 1 },
  });
});

test("isolates kernel variables between session identities", async () => {
  // Given: one session holds a variable.
  await (await execute(randomUUID(), "globalThis.secret = 42")).json();
  // When: a different session reads that name.
  const result = await (await execute(randomUUID(), "typeof secret")).json();
  // Then: the other context cannot see it.
  expect(result).toMatchObject({ status: "ok", result: "undefined" });
});

test("resets the heap without deleting durable tool data", async () => {
  // Given: a session has volatile state and a saved note.
  const session = randomUUID();
  const before = await (
    await execute(
      session,
      'var x = 42; tools.notes.save({key:"answer",value:x})'
    )
  ).json();
  // When: the context is explicitly reset.
  const reset = await (
    await worker.fetch(`/sessions/${session}/reset`, {
      method: "POST",
    })
  ).json();
  const after = await (
    await execute(
      session,
      '(async()=>({variable:typeof x,note:await tools.notes.get({key:"answer"})}))()'
    )
  ).json();
  // Then: the heap changed generation but the storage-backed note remains.
  expect(reset.generation).not.toBe(before.generation);
  expect(after).toMatchObject({
    status: "ok",
    result: { variable: "undefined", note: 42 },
  });
});

test("settles a guest promise without host tool calls", async () => {
  // Given: no host operations are pending.
  const session = randomUUID();
  // When: the script returns an already-resolved promise.
  const result = await (await execute(session, "Promise.resolve(42)")).json();
  // Then: the guest job queue is pumped and completes.
  expect(result).toMatchObject({ status: "ok", result: 42, calls: [] });
});

test("returns a tool error and resets the failed context", async () => {
  // Given: a valid session with a previously created global.
  const session = randomUUID();
  await (await execute(session, "var previous = 42")).json();
  // When: a host tool rejects an unknown SKU.
  const result = await (
    await execute(session, 'tools.pricing.quote({sku:"missing",quantity:1})')
  ).json();
  // Then: failure is visible with a trace, and stale globals are gone.
  expect(result).toMatchObject({
    status: "error",
    stateReset: true,
    calls: [{ tool: "pricing.quote", status: "error" }],
  });
  expect(
    await (await execute(session, "typeof previous")).json()
  ).toMatchObject({
    status: "ok",
    result: "undefined",
  });
});

test("lets guest code catch a rejected host tool promise", async () => {
  // Given: a program with explicit error handling.
  const session = randomUUID();
  // When: the tool rejects and the guest catches it.
  const result = await (
    await execute(
      session,
      '(async()=>{try {await tools.pricing.quote({sku:"missing",quantity:1});} catch {return "caught";}})()'
    )
  ).json();
  // Then: the overall execution succeeds without discarding handled errors.
  expect(result).toMatchObject({
    status: "ok",
    result: "caught",
    calls: [{ tool: "pricing.quote", status: "error" }],
  });
});

test.each([
  ["synchronous loop", "while (true) {}"],
  ["promise loop", "(async()=>{while(true) await Promise.resolve();})()"],
  ["unsettled promise", "new Promise(()=>{})"],
  ["cyclic result", "var cyclic={}; cyclic.self=cyclic; cyclic"],
  ["invalid syntax", "const ="],
])("bounds %s and permits a fresh next execution", async (_label, code) => {
  // Given: a new session and code that cannot finish normally.
  const session = randomUUID();
  // When: that program is evaluated.
  const result = await (await execute(session, code)).json();
  // Then: the failed VM is reset, rather than hanging the session.
  expect(result).toMatchObject({ status: "error", stateReset: true });
  expect(await (await execute(session, "6 * 7")).json()).toMatchObject({
    status: "ok",
    result: 42,
  });
});

test("enforces the documented synchronous loop boundary", async () => {
  // Given: this loop polls twice per iteration in pinned QuickJS 0.32 (~5M iterations).
  const below = randomUUID();
  const above = randomUUID();
  // When: both programs run through real QuickJS/WASM over HTTP.
  const accepted = await (
    await execute(below, "for (var i=0;i<4900000;i++) {} i")
  ).json();
  const rejected = await (
    await execute(above, "for (var i=0;i<5100000;i++) {} i")
  ).json();
  // Then: useful bounded computation completes, while excess synchronous work resets the VM.
  expect(accepted).toMatchObject({ status: "ok", result: 4_900_000 });
  expect(rejected).toMatchObject({
    status: "error",
    error: { code: "INSTRUCTION_LIMIT" },
    stateReset: true,
  });
  expect(await (await execute(above, "typeof i")).json()).toMatchObject({
    status: "ok",
    result: "undefined",
  });
  expect(await (await execute(above, "6 * 7")).json()).toMatchObject({
    status: "ok",
    result: 42,
  });
});

test("does not expose host process, filesystem, or network globals", async () => {
  // Given: an empty guest context.
  const session = randomUUID();
  // When: code checks host-only capabilities.
  const result = await (
    await execute(
      session,
      "[typeof process,typeof Bun,typeof fetch,typeof require]"
    )
  ).json();
  // Then: only explicit bridged tools can reach host capabilities.
  expect(result).toMatchObject({
    status: "ok",
    result: ["undefined", "undefined", "undefined", "undefined"],
  });
});

test("rejects invalid eval input before touching the kernel", async () => {
  // Given: an HTTP caller with invalid code input.
  const session = randomUUID();
  // When: non-string code is submitted.
  const response = await execute(session, 123);
  await response.json();
  // Then: the HTTP boundary rejects the request.
  expect(response.status).toBe(400);
});

test("rejects new tool calls while serializing a completed result", async () => {
  // Given: a result serializer tries to start a new host operation.
  const session = randomUUID();
  const code =
    '({toJSON(){tools.notes.save({key:"late",value:42});return "done";}})';
  // When: the completed result crosses the JSON boundary.
  const result = await (await execute(session, code)).json();
  // Then: serialization fails before a host tool is invoked.
  expect(result).toMatchObject({
    status: "error",
    stateReset: true,
    calls: [],
  });
});

test("serializes overlapping cells while async host tools are running", async () => {
  // Given: both cells increment a shared value across a real async storage call.
  const session = randomUUID();
  await (await execute(session, "var counter=0")).json();
  const code =
    '(async()=>{const before=counter; await tools.notes.save({key:"counter",value:before+1}); counter=before+1; return counter;})()';
  // When: two HTTP callers submit overlapping eval requests.
  const results = await Promise.all(
    [execute(session, code), execute(session, code)].map(async (response) =>
      (await response).json()
    )
  );
  // Then: no increment is lost across the host await boundary.
  expect(results.map((result) => result.result).sort()).toEqual([1, 2]);
});
