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

## Advanced Features

### 1. Stateless History Hydration & Dehydration
For serverless or stateless environments (like Cloudflare Workers), where the agent instance is re-created on every request, you can hydrate the session with an existing message history and retrieve the updated history snapshot after execution.

```ts
import { Agent, type AgentMessage } from "@minpeter/pss-runtime";

// Hydrate session with historical messages
const initialHistory: AgentMessage[] = [
  { role: "user", content: "Hello!" },
  { role: "assistant", content: "Hi! How can I help you today?" }
];

const session = agent.createSession({
  history: initialHistory,
});

// Retrieve history snapshot at any point
const currentHistory: AgentMessage[] = session.getHistory();
```

### 2. Safe Event Subscriptions
When subscribing to session events (such as text streaming, tool calls, and turn lifecycle updates), it is highly recommended to unsubscribe in a `finally` block to prevent event listener leaks, especially in persistent environments or multi-turn execution loops.

```ts
const session = agent.createSession();

// Subscribe to events and get the unsubscribe function
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "assistant-text":
      process.stdout.write(event.text);
      break;
    case "tool-call":
      console.log(`\nCalling tool: ${event.name}`);
      break;
  }
});

try {
  await session.submit({ type: "user-text", text: "What's the weather today?" });
} finally {
  // Always clean up to prevent memory/listener leaks!
  unsubscribe();
}
```

