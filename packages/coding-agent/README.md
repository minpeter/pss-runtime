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

## CLI

```sh
pnpm dlx @minpeter/pss-coding-agent
```

```sh
pnpm add -g @minpeter/pss-coding-agent
pss
```

Bin aliases: `pss`, `pss-coding-agent`.

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
