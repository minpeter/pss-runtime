# @minpeter/pss-runtime

Reusable pss-next agent runtime for sessions, model loops, and event streams.

```ts
import { Agent, type AgentModel } from "@minpeter/pss-runtime";

const model: AgentModel = createYourLanguageModel();
const agent = new Agent({
  instructions: "Answer briefly.",
  model,
});
const session = agent.createSession();
```

The runtime does not read environment variables or create a default provider.
Pass a caller-owned `LanguageModel` through `model`, or pass a custom `llm`.
Product tools are intentionally not included; pass tools from a separate package
when constructing an `Agent`.
