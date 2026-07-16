---
packages:
  "npm:@minpeter/pss-runtime": minor
---

## Introduce a factory-based plugin runtime

Replace object plugins with an async factory registration kernel built around
`definePlugin`, typed `on` events, and extensible `provide` capabilities. Add
sequential async factory initialization, fail-closed hooks, subscriptions,
thread-scoped state, and index-based host diagnostics. Use `model.context` for
ephemeral model-input guards and add an atomic `model.step.before` transform
before generated messages enter history or emit mapped output events.
Dispatch the declared thread, turn, step, message, provider, compaction, and tool
lifecycle hooks at their runtime boundaries, including model-context hooks for
automatic-compaction requests. Apply typed request decisions for input
handling, transforms, compaction cancellation, tool blocking, and manual tool
recovery, and reject malformed runtime decisions with `PluginHookError`.
Plugin hook names use lowercase dotted paths, including
`provider.request.before`, `provider.response.after`,
`model.step.before`, `thread.compaction.before`, `thread.compaction.after`,
`tool.call.before`, and `turn.start.before`.

Keep thread-state shape validation inside the runtime and leave persisted
history repair to a separate version-checked recovery job with an auditable
before/after object diff.

Replace the root `Agent` constructor and `Agent.create()` surface with the async
`createAgent()` factory. `Agent` remains available as a type, while all plugin
factories finish initialization before `createAgent()` resolves.

Flatten event-backed plugin hook payloads so handlers receive their narrowed
event directly, and expose `registerTool()` as the tool capability helper.
