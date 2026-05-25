# @minpeter/pss-coding-agent

Web tools, model wiring, and the `pss` TUI for pss-next.

```ts
import { tools } from "@minpeter/pss-coding-agent";
import { createCodingAgentModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const agent = await Agent.create({
  model: createCodingAgentModel(),
  tools,
});

const run = await agent.send("Hello from pss");
for await (const event of run.stream()) {
  console.dir(event, { depth: null });
}
```

`run.stream()` is synchronized and drives the run. The runtime waits at
`turn-start`, `step-start`, and `step-end` until the stream consumer continues,
so consume the stream to let the run progress. During those current-turn input
windows, `run.input.add(input)` accepts the same input shapes as
`session.send(input)` and inserts input into the active turn only.

```ts
const session = agent.session("default");
const run = await session.send("Explain the latest result.");
let askedForExample = false;

for await (const event of run.stream()) {
  if (event.type === "step-end" && !askedForExample) {
    askedForExample = true;
    await run.input.add("Add one concrete example.");
  }
}
```

Guard `step-end` additions. Runtime input added at `step-end` intentionally
continues the current turn before the next model snapshot, even if the assistant
already printed final-looking text. Adding input on every `step-end` can keep the
turn running indefinitely.

Runtime additions emit `runtime-input`: runtime/API-originated input mapped
internally to the model's user role, separate from human `user-text` and
`user-message` events. `session.send(input)` starts or enqueues a new turn;
`run.input.add(input)` is current-turn-only and rejects after `turn-end`,
`turn-error`, `turn-abort`, stream `return()`, or `kill()`.

## CLI

```sh
pnpm dlx @minpeter/pss-coding-agent
```

```sh
pnpm add -g @minpeter/pss-coding-agent
pss
```

Bin aliases: `pss`, `pss-coding-agent`.

When the TUI is idle, submitting text starts a normal `session.send()` turn. When
a run is active, submitting text calls `activeRun.input.add(trimmed)` so the text
lands in the current run and renders as dim `runtime: ...` input instead of a
new human turn.

## Env

Set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` for the model.
Set `TINYFISH_API_KEY` before using `web_search` or `web_fetch`.

The TUI persists runtime-owned session state to files by default:

- `PSS_SESSION_DIR` overrides the store directory. Default: `~/.pss/sessions`.
- `PSS_SESSION_KEY` overrides the conversation key. Default: `cwd:<current working directory>`.

Examples:

```sh
pss
PSS_SESSION_KEY=workspace:demo pss
PSS_SESSION_DIR=.pss/sessions pss
```

## Dev

```sh
pnpm dev:tui
```
