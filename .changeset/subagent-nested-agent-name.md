---
"@minpeter/pss-runtime": patch
---

Remove `name` from `Agent` and `AgentOptions`. Use `namespace` for session scoping on every agent. Use `SubagentDefinition.name` for delegation identity. Passing `options.name` now throws at construction time. Nested subagent children require `agent.namespace`.