# @minpeter/pss-coding-agent

Model wiring and the `pss` TUI for pss-next. This package ships no built-in
tools; bring your own `ToolSet` when you want tool calling.

```ts
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const agent = new Agent({
  model: createCodingLanguageModel(),
});

const turn = await agent.send("Hello from pss");
for await (const event of turn.events()) {
  console.dir(event, { depth: null });
}
```

`turn.events()` is synchronized and drives the turn. The runtime waits at
`turn-start`, `step-start`, and `step-end` until the events consumer continues,
so consume the events to let the turn progress. Use `thread.send(input)` for a
new user turn and `thread.steer(input)` to steer the active turn. If no turn is
active, `thread.steer(input)` starts a normal turn.

```ts
const thread = agent.thread("default");
const turn = await thread.send("Explain the latest result.");
let askedForExample = false;

for await (const event of turn.events()) {
  if (event.type === "step-end" && !askedForExample) {
    askedForExample = true;
    await thread.steer("Add one concrete example.");
  }
}
```

Guard `step-end` additions. Runtime input added at `step-end` intentionally
continues the current turn before the next model snapshot, even if the assistant
already printed final-looking text. Adding input on every `step-end` can keep
the turn running indefinitely.

Runtime additions emit `runtime-input`: runtime/API-originated input mapped
internally to the model's user role, separate from human `user-text` and
`user-message` events. `thread.send(input)` starts or enqueues a new turn;
`thread.steer(input)` steers the active turn or starts a normal turn when idle.

## CLI

```sh
pnpm dlx @minpeter/pss-coding-agent
```

```sh
pnpm add -g @minpeter/pss-coding-agent
pss
```

CLI commands: `pss`, `pss-coding-agent`.

The `pss` TUI starts a plain conversational agent with no built-in tools. To run
the TUI with tools, call `startTui({ tools })` from your own entrypoint (for
example to wire `@minpeter/pss-web-tools`):

```ts
import { startTui } from "@minpeter/pss-coding-agent";

await startTui({ tools });
```

When the TUI is idle, submitting text starts a normal `thread.send()` turn. When
a run is active, submitting text calls `thread.steer(trimmed)` so the text lands
in the current turn and renders as dim `runtime: ...` input instead of a new human
turn.

## Env

Set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` for the model.

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
