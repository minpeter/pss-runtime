# pss-next

Small agent runtime workspace.

- `@minpeter/pss-runtime`: runtime, sessions, model loop.
- `@minpeter/pss-coding-agent`: web tools, model wiring, and the `pss` TUI.

## Use

```ts
import { tools } from "@minpeter/pss-coding-agent";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const agent = await Agent.create({
  instructions: "Keep every answer under 3 lines.",
  model: createCodingLanguageModel(),
  tools,
});
const run = await agent.send("Hello");
for await (const event of run.stream()) {
  console.dir(event, { depth: null });
}
```

`run.stream()` is synchronized and drives the run. Consume it to let the runtime
cross lifecycle boundaries such as `turn-start`, `step-start`, and `step-end`.
Use `session.send(input)` for a new user turn. If a run is already active, the
turn is queued until the active run finishes. Use `session.steer(input)` when the
input should steer the active run; if no run is active, it starts a normal run.

```ts
const session = agent.session("default");
const run = await session.send("Write a two sentence summary.");
let addedConstraint = false;

for await (const event of run.stream()) {
  if (event.type === "step-end" && !addedConstraint) {
    addedConstraint = true;
    await session.steer("Keep the second sentence under 10 words.");
  }
}
```

The guard matters. `step-end` runtime input asks the runtime to continue the
current turn before the next model snapshot, even after final-looking assistant
text. Adding input on every `step-end` can keep a turn running indefinitely.

Steering additions appear as `runtime-input` events: runtime/API-originated input
mapped internally to the model's user role, separate from human `user-text` and
`user-message` events.

The runtime `send` API also accepts JSON-serializable multimodal content parts
for model providers that support them:

```ts
await agent.send([
  { type: "text", text: "What changed in this screenshot?" },
  { type: "image", image: "data:image/png;base64,...", mediaType: "image/png" },
]);
```

Run the TUI:

```sh
pnpm dlx @minpeter/pss-coding-agent
```

or install it:

```sh
pnpm add -g @minpeter/pss-coding-agent
pss
```

In the `pss` TUI, submitting while a run is active steers the current run.
Submitting while idle starts a normal new turn.

## Develop

```sh
pnpm install
pnpm dev
pnpm dev:tui
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## Env

Copy `.env.example` to `.env`.

```env
AI_API_KEY=...
AI_BASE_URL=...
AI_MODEL=...
TINYFISH_API_KEY=...
```

`TINYFISH_API_KEY` may contain semicolon-delimited tokens.

The `pss` TUI stores sessions in `~/.pss/sessions` by default. Override with
`PSS_SESSION_DIR` and `PSS_SESSION_KEY` when you want repo-local storage or a
shared conversation key.

## Release

```sh
pnpm changeset
pnpm version-packages
pnpm build
pnpm verify:release
pnpm release
```

Releases use Changesets and npm Trusted Publishing.
