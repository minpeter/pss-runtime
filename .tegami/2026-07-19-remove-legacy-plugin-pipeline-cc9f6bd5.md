---
packages:
  "npm:@minpeter/pss-runtime": minor
---

## Remove the legacy object-style plugin pipeline

Drop dual dispatch for object plugins (`AgentPlugin` / `{ on(context) }` /
`runPluginsForEvent`). Plugin behavior now runs only through factory-style
`definePlugin` handlers on `PluginRuntime`.

`createAgent({ plugins })` remains the supported registration path.
`new Agent(...)` no longer accepts a `plugins` option; use `createAgent` so
plugin factories initialize before the agent is returned.

Migrate any remaining object plugins to:

```ts
definePlugin((pss) => {
  pss.on("input.accept", handler);
});
```
