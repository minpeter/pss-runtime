# @minpeter/pss-coding-agent

Web tools, model wiring, and the `pss` TUI for pss-next.

```ts
import { tools } from "@minpeter/pss-coding-agent";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const agent = await Agent.create({
  model: createCodingLanguageModel(),
  tools,
});

const run = await agent.send("Hello from pss");
for await (const event of run.events()) {
  console.dir(event, { depth: null });
}
```

`run.events()` is synchronized and drives the run. The runtime waits at
`turn-start`, `step-start`, and `step-end` until the events consumer continues,
so consume the events to let the run progress. Use `session.send(input)` for a
new user turn and `session.steer(input)` to steer the active run. If no run is
active, `session.steer(input)` starts a normal run.

```ts
const session = agent.session("default");
const run = await session.send("Explain the latest result.");
let askedForExample = false;

for await (const event of run.events()) {
  if (event.type === "step-end" && !askedForExample) {
    askedForExample = true;
    await session.steer("Add one concrete example.");
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
`session.steer(input)` steers the active run or starts a normal run when idle.

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
a run is active, submitting text calls `session.steer(trimmed)` so the text lands
in the current run and renders as dim `runtime: ...` input instead of a new human
turn.

Press `Ctrl+V` to attach one PNG or JPEG image from the clipboard to the current
draft. Press `Enter` to submit the draft text plus any attachment through the
runtime's multipart input. If a run is active, the multipart draft steers that
run; otherwise it starts a new turn.

Attachment and error lines only show metadata such as `[attached image/png]` or a
short clipboard message. They don't print raw data URIs. Automated tests mock
clipboard and platform behavior; real runtime support depends on the available OS
clipboard command backend. macOS uses `pngpaste`, Linux Wayland uses `wl-paste`,
and Linux X11 uses `xclip` when the matching display environment is present.

When look-at vision calls fail, the injected tool returns a concise bounded tool
error such as `Vision model failed` and the session continues.

## Env

Set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` for the main model.
Set `TINYFISH_API_KEY` before using `web_search` or `web_fetch`.

Set `PSS_LOOK_AT_MODEL` to enable image inspection through the runtime
`look_at` tool. When it is unset or empty, `look_at` is disabled. The `look_at` model
uses these exact env vars:

- `PSS_LOOK_AT_MODEL`: vision model id. Required to enable `look_at`.
- `PSS_LOOK_AT_BASE_URL`: vision provider base URL. Defaults to `AI_BASE_URL`, then `https://apis.opengateway.ai/v1`.
- `PSS_LOOK_AT_API_KEY`: vision provider API key. Defaults to `AI_API_KEY` after look-at is enabled.
- `PSS_LOOK_AT_MAX_OUTPUT_CHARS`: maximum text returned by one vision tool result. Default: `2000`.
- `PSS_LOOK_AT_MAX_IMAGE_BYTES`: maximum image size accepted by look-at. Default: `10485760`.

Example:

```sh
PSS_LOOK_AT_MODEL=vision-model-id pss
PSS_LOOK_AT_MODEL=vision-model-id PSS_LOOK_AT_BASE_URL=https://example.invalid/v1 pss
```

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
