# @minpeter/pss-coding-agent

Coding-agent product package for pss-next. It provides TinyFish-backed web tools
and keeps TUI startup isolated from the side-effect-free root import.

```ts
import { tools, webFetchTool, webSearchTool } from "@minpeter/pss-coding-agent";
import { Agent } from "@minpeter/pss-runtime";

const agent = new Agent({ tools });
```

Set `TINYFISH_API_KEY` before invoking `web_search` or `web_fetch`. Token pools
can be provided as semicolon-delimited values.

```bash
node --conditions=@minpeter/pss-source --import tsx packages/coding-agent/src/tui.ts
```
