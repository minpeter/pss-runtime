import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:8788";
const session = `demo-${randomUUID()}`;

async function post(path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

// One client request stands in for one model code-tool invocation.
const composed = await post(`/sessions/${session}/eval`, {
  code: `(async () => {
    const products = await tools.catalog.search({ query: "keyboard" });
    const quotes = await Promise.all(products.map(product =>
      tools.pricing.quote({ sku: product.sku, quantity: 2 })
    ));
    globalThis.lastQuote = quotes.toSorted((a, b) => a.totalCents - b.totalCents)[0];
    return await tools.notes.save({ key: "recommendation", value: lastQuote });
  })()`,
});
assert.equal(composed.status, "ok", JSON.stringify(composed));
assert.deepEqual(composed.result, {
  key: "recommendation",
  value: { sku: "kbd-basic", quantity: 2, totalCents: 8000 },
});
assert.deepEqual(
  composed.calls.map((call) => call.tool),
  ["catalog.search", "pricing.quote", "pricing.quote", "notes.save"],
);
assert.ok(composed.calls.every((call) => call.status === "ok"));
console.log(
  JSON.stringify(
    {
      check: "one-code-tool-invocation",
      clientRequests: 1,
      hostToolCalls: composed.calls.length,
      session,
      generation: composed.generation,
      result: composed.result,
      calls: composed.calls,
    },
    null,
    2,
  ),
);

const retained = await post(`/sessions/${session}/eval`, {
  code: "lastQuote.totalCents",
});
assert.equal(retained.status, "ok");
assert.equal(retained.result, 8000);
assert.equal(retained.generation, composed.generation);

const isolatedSession = `other-${randomUUID()}`;
const isolated = await post(`/sessions/${isolatedSession}/eval`, {
  code: "typeof lastQuote",
});
assert.equal(isolated.result, "undefined");

const reset = await post(`/sessions/${session}/reset`, {});
assert.notEqual(reset.generation, composed.generation);
const afterReset = await post(`/sessions/${session}/eval`, {
  code: '(async()=>({variable:typeof lastQuote,note:await tools.notes.get({key:"recommendation"})}))()',
});
assert.equal(afterReset.status, "ok");
assert.equal(afterReset.result.variable, "undefined");
assert.deepEqual(afterReset.result.note, composed.result.value);
await post(`/sessions/${session}/reset`, {});
await post(`/sessions/${isolatedSession}/reset`, {});
console.log(
  JSON.stringify(
    {
      check: "lifecycle",
      persistentAcrossCells: true,
      isolatedSessions: true,
      resetClearsHeap: true,
      resetPreservesNotes: true,
    },
    null,
    2,
  ),
);
