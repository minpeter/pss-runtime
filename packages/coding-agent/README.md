# @minpeter/pss-coding-agent

Web tools, model wiring, and the `pss` TUI for pss-next.

```ts
import { tools } from "@minpeter/pss-coding-agent";
import { createCodingAgentModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const session = new Agent({
  model: createCodingAgentModel(),
  tools,
}).createSession();
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

## Dev

```sh
pnpm dev:tui
```
