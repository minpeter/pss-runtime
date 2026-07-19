---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Add OpenTelemetry turn tracing

Add the `@minpeter/pss-runtime/otel` subpath with `traceAgentTurn()` for one
turn and `openTelemetry()` for agent-wide instrumentation. Record turn, step,
and tool spans plus metadata-only runtime events through
`@opentelemetry/api`, leaving SDK and exporter configuration to applications.

Expose general `AgentOptions.instrumentations` hooks for send, steer, and
resume operations. Wrapped turns preserve single-consumption and pass through
every original event, including model-usage telemetry, while payload summaries
avoid raw content and do not invoke `toJSON()`.
