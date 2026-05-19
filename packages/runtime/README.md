# @pss-next/runtime

Reusable pss-next agent runtime for sessions, model loops, and event streams.

```ts
import { Agent } from "@pss-next/runtime";

const agent = new Agent({
  instructions: "Answer briefly.",
});
const session = agent.createSession();
```

Configure the default OpenAI-compatible model with `AI_API_KEY`, `AI_BASE_URL`,
and `AI_MODEL`. Product tools are intentionally not included; pass tools from a
separate package when constructing an `Agent`.
