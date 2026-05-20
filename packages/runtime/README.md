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

## Session history

Use `history` when the caller already owns the stored model-message history and
needs a new `AgentSession` to continue from that state. This is the best fit for
stateless request handlers, background jobs, and tests that persist history
outside the runtime.

```ts
import { type AgentMessage } from "@minpeter/pss-runtime";

const history: AgentMessage[] = [
  { role: "user", content: "Hello!" },
  { role: "assistant", content: "Hi! How can I help you today?" },
];

const session = agent.createSession({ history });

const currentHistory: AgentMessage[] = session.getHistory();
```

`getHistory()` returns a cloned snapshot, so callers can persist or inspect it
without mutating the session.

### Reactive storage synchronization

Use `onHistoryChange` when the host should persist every history mutation as the
turn runs. Calls are serialized, receive the mutation-time snapshot, and are
awaited before `submit()` resolves, rejects, or advances to the next queued
turn. If persistence fails, the turn rolls back in-memory history and surfaces a
`turn-error`.

This is the best fit for stateful serverless hosts such as Cloudflare Durable
Objects, where a long-lived session mirrors history into Durable Object Storage,
SQLite, or another caller-owned store.

```ts
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentSession,
} from "@minpeter/pss-runtime";

export class AgentDurableObject {
  private agent: Agent;
  private session: AgentSession | null = null;
  private storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
    this.agent = new Agent({
      instructions: "You are a helpful assistant.",
      model: yourLanguageModel,
    });
  }

  private async getSession() {
    if (this.session) {
      return this.session;
    }

    const history =
      (await this.storage.get<AgentMessage[]>("history")) ?? [];

    this.session = this.agent.createSession({
      history,
      onHistoryChange: async (nextHistory) => {
        await this.storage.put("history", nextHistory);
      },
    });
    return this.session;
  }

  async fetch(request: Request) {
    const { message } = await request.json<{ message: string }>();
    const session = await this.getSession();
    let responseText = "";

    const unsubscribe = session.subscribe((event: AgentEvent) => {
      if (event.type === "assistant-text") {
        // In a real Worker, write this to a TransformStream, WebSocket, or
        // channel-specific delivery queue. This also receives text emitted
        // before a tool call in the same model step.
        responseText += event.text;
      }
    });

    try {
      await session.submit({ type: "user-text", text: message });
    } finally {
      unsubscribe();
    }

    return Response.json({
      history: session.getHistory(),
      response: responseText,
    });
  }
}
```

### Safe event subscriptions

When subscribing to session events, unsubscribe in a `finally` block to prevent
listener leaks in persistent environments or multi-turn execution loops.

```ts
const session = agent.createSession();

// Subscribe to events and get the unsubscribe function
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "assistant-text":
      process.stdout.write(event.text);
      break;
    case "tool-call":
      console.log(`\nCalling tool: ${event.toolName}`);
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

Visible assistant text is emitted as `assistant-text` events in model-message
order. If a single assistant model message contains both a text part and a
tool-call part, subscribers receive the text first and the tool call afterward:

```txt
step-start
assistant-text   // visible text before the tool call
tool-call
tool-result      // if the LLM adapter returns tool results for that step
step-end
step-start       // the next loop iteration after tool results are appended
...
```

Hosts that deliver “pre-tool” bubbles should subscribe to `assistant-text`
events instead of reconstructing partial messages from history. Use
`getHistory()` after `submit()` for durable snapshots, memory indexing, or other
post-turn inspection.

`submit()` also accepts `text` as an array of strings. The runtime keeps those
strings together as one user turn and forwards them to the model as AI SDK text
content parts, which is useful when the host needs to prepend per-turn context
without flattening it into the user's visible message.

```ts
await session.submit({
  type: "user-text",
  text: [
    "Context: user timezone is Asia/Seoul.",
    "Please remind me tomorrow morning.",
  ],
});
```
