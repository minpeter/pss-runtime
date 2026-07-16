---
"@minpeter/pss-runtime": minor
---

Add an opt-in `llmTransport: "stream-collect"` agent option that routes every model step (turn steps and auto-compaction summaries) through `streamText` with identical parameters, awaited to completion. The default (`"generate"`) keeps the existing non-streaming `generateText` behavior unchanged. Model errors reported through the stream are captured and rethrown as-is, so both transports surface identical failures.
