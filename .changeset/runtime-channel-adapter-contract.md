---
"@minpeter/pss-runtime": patch
---

Add a minimal channel adapter contract on the `./channel` subpath so delivery
adapters can map inbound channel messages to thread turns and project visible
assistant output without widening the runtime package root.
