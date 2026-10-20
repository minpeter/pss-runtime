# pss-kernel

A containerless codemode proof of concept that maintains a QuickJS/WASM context inside a Cloudflare Durable Object.
Instead of having the model respond again for each tool, it **performs multiple asynchronous tool calls and processes their results with a single piece of code**.

```text
client -- one eval request --> Worker --> session Durable Object
                                           |
                                     QuickJS context
                                           |
                              catalog -> quotes -> save note
                                           |
                                    DO SQLite storage
client <-- result + tool trace ------------+
```

## Run locally

This package moves the standalone `pss-kernel` project into `packages/kernel`
in the `pss-runtime` workspace. The package is named `@minpeter/pss-kernel` and
is still a private PoC that is not published to npm. It is not connected to the
kernel implementations in `packages/runtime` or `experimental/apifuse-playground-bench`.

Like the rest of the repository, it requires Node.js 24 or later and the pnpm version specified at the root.
Docker, a Cloudflare account, and an LLM API key are not required. Run the commands below from the repository root.

```sh
pnpm install
pnpm --filter @minpeter/pss-kernel dev
# In a separate terminal
pnpm --filter @minpeter/pss-kernel demo
```

The default address is `http://127.0.0.1:8788`; on a LAN, connect with an address such as `http://10.10.10.10:8788`.
For a different port, use `pnpm --filter @minpeter/pss-kernel demo http://127.0.0.1:8787`.
`dev` runs `wrangler dev --local --ip 0.0.0.0 --port 8788`. Other devices on the same LAN can
connect through the host's LAN IP. It does not use remote resources or deployment.
The root route (`/`) returns API information as JSON. There is no web UI for entering code in a browser.

## Four tool calls in one request

```sh
curl http://127.0.0.1:8788/sessions/example/eval \
  -H 'content-type: application/json' \
  --data '{"code":"(async()=>{const products=await tools.catalog.search({query:\"keyboard\"}); const quotes=await Promise.all(products.map(p=>tools.pricing.quote({sku:p.sku,quantity:2}))); globalThis.lastQuote=quotes.toSorted((a,b)=>a.totalCents-b.totalCents)[0]; return await tools.notes.save({key:\"recommendation\",value:lastQuote});})()"}'
```

The response's `calls` records `catalog.search`, two `pricing.quote` calls, and `notes.save`.
The final result is two `kbd-basic` items with `totalCents: 8000`. QuickJS handles filtering,
sorting, and dependencies between calls without asking the client or model for another decision.
The tools themselves are called four times.

This PoC does not actually call an LLM. The code above stands in for model-generated code and
verifies the **execution path that composes tools in a single code-tool invocation**.
It is not a benchmark for token savings or model accuracy.

## State between cells

```sh
curl http://127.0.0.1:8788/sessions/example/eval \
  -H 'content-type: application/json' --data '{"code":"lastQuote.totalCents"}'
# result: 8000
```

- The same session ID is routed to the same DO. Globals and notes are isolated between sessions.
- A global script's `var`, `let`, `const`, and functions remain available in subsequent cells.
- **Bare top-level await is not supported.** Wrap asynchronous code in `(async () => { ... })()`.
- Local variables inside an async function are not shared between cells. To preserve an asynchronous result,
  use `globalThis.lastQuote = ...` or a previously declared global variable.
- Redeclaring `const` or `let` is an error, as in ordinary JavaScript.
- `generation` identifies the current kernel generation. It changes after a reset or execution failure.

```sh
curl -X POST http://127.0.0.1:8788/sessions/example/reset
```

Reset removes only the QuickJS heap; it does not delete notes saved by tools.
The heap may also be lost after DO eviction, deployment, or a Wrangler restart/code reload.
This PoC has no keepalive, idle-retention policy, or heap persistence and recovery.
Local persistence in DO storage and survival of the QuickJS heap are separate concerns.

## API and tools

| API | Purpose |
| --- | --- |
| `GET /` | Show the service name and API routes |
| `GET /health` | Check the execution environment |
| `GET /tools` | List tool names and input JSON Schemas |
| `POST /sessions/:id/eval` | Execute `{ "code": "..." }` |
| `POST /sessions/:id/reset` | Release the kernel and change its generation |

| Guest tool | Behavior |
| --- | --- |
| `tools.catalog.search({query})` | Search demo products |
| `tools.pricing.quote({sku, quantity})` | Calculate a product price |
| `tools.notes.save({key, value})` | Save a JSON note |
| `tools.notes.get({key})` | Retrieve a note, or null if absent |

The tools use the real asynchronous DO SQLite-backed storage API. Products and prices are fixed demo
data, not an external store API. The replacement point is `invokeTool` in `src/tools.ts`.

A successful response includes `status`, `result`, `calls`, `generation`, and `executionId`.
A guest execution error returns HTTP 200 with `status: "error"` and `stateReset: true`, then discards the kernel.
Writes from tools that already ran are not rolled back. Invalid HTTP input returns 400.

## Validation

```sh
pnpm --filter @minpeter/pss-kernel test       # Real Wrangler/workerd HTTP integration tests
pnpm --filter @minpeter/pss-kernel typecheck
pnpm --filter @minpeter/pss-kernel lint
pnpm --filter @minpeter/pss-kernel build      # Bundle dry run including WASM; does not deploy to the cloud
```

## Scope

- QuickJS does not expose the host's `process`, `Bun`, `require`, `fetch`, files, shell, git, or browser.
- Only explicitly registered tools with JSON inputs and outputs can be called. No import module loader is provided.
- Eval/reset operations are serialized within a session. `Promise.all` tool calls within one cell may run in parallel.
- Infinite loops, excessive Promise jobs, unresolved Promises, and invalid result serialization are limited.
- Each cell allows up to 1,000 QuickJS interrupt callbacks and fails with `INSTRUCTION_LIMIT`
  and resets on the 1,001st. The pinned QuickJS 0.32 performs 10,000 interrupt polls between
  callbacks. Polling occurs at branches, function calls, and similar points rather than after every
  instruction, so this is not a JavaScript statement count or an exact execution-time limit.
  The previous limit of 10,000 callbacks allowed synchronous execution alone to exceed 10 seconds under local CPU contention.
  Timers cannot interrupt synchronous WASM, and the Workers clock may not update during execution
  in some environments, so this workload limit does not depend on a clock or timer.
  The limits remain 10 seconds of asynchronous waiting, 10,000 Promise jobs, 64 tool calls,
  64 KiB of JSON, a 16 MiB heap, and a 256 KiB stack.
- This is a **local PoC** without authentication, per-user quotas, or production event logging.
- These local tests do not validate cloud deployment, automatic eviction, or costs.

References: [Wrangler local development](https://developers.cloudflare.com/workers/local-development/),
[QuickJS Workers example](https://github.com/justjake/quickjs-emscripten/tree/main/examples/cloudflare-workers).
