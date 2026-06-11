---
"@minpeter/pss-runtime": patch
---

Remove the public runtime LLM function adapter surface. Agent model execution now accepts AI SDK LanguageModel objects directly, and runtime tests use AI SDK MockLanguageModelV4 fixtures.
