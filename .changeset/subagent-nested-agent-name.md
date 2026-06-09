---
"@minpeter/pss-runtime": patch
---

Nested subagent child agents must not set `name`. Use `SubagentDefinition.name` for delegation identity and `agent.namespace` for child session scoping. Setting `name` on a nested child agent now throws at construction time.