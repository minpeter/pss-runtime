# @minpeter/pss-coding-agent

Coding-agent product package for pss-next. It provides TinyFish-backed web tools
and keeps TUI startup isolated from the side-effect-free root import.

```ts
import { tools } from "@minpeter/pss-coding-agent";
import { createCodingAgentModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const agent = new Agent({
  model: createCodingAgentModel(),
  tools,
});
```

Set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` to configure the
OpenAI-compatible model used by `createCodingAgentModel`; the
model subpath validates these values before constructing a `LanguageModel`.
Set `TINYFISH_API_KEY` before invoking `web_search` or `web_fetch`. Token pools
can be provided as semicolon-delimited values and are validated when the tools
are invoked.

```bash
node --conditions=@minpeter/pss-source --import tsx packages/coding-agent/src/tui.ts
```
