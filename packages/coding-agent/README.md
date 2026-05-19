# @pss-next/coding-agent

Coding-agent product package for pss-next. It provides TinyFish-backed web tools
and keeps TUI startup isolated from the side-effect-free root import.

```ts
import { tools, webFetchTool, webSearchTool } from "@pss-next/coding-agent";
import { Agent } from "@pss-next/runtime";

const agent = new Agent({ tools });
```

Set `TINYFISH_API_KEY` before invoking `web_search` or `web_fetch`. Token pools
can be provided as semicolon-delimited values.

```bash
node --conditions=@pss-next/source --import tsx packages/coding-agent/src/tui.ts
```
