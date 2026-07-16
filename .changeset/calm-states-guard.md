---
"@minpeter/pss-runtime": minor
---

Replace object plugins with an async factory registration kernel built around
`definePlugin`, typed `on` events, and extensible `provide` capabilities. Add
sequential async factory initialization, fail-closed hooks, subscriptions,
thread-scoped state, index-based host diagnostics, and canonical-history
policies at load, append, compaction, model-context, and persistence boundaries.
Dispatch the declared thread, turn, step, message, provider, compaction, and tool
lifecycle hooks at their runtime boundaries, including model-context hooks for
automatic-compaction requests. Apply typed request decisions for input
handling, transforms, compaction cancellation, tool blocking, and manual tool
recovery, and reject malformed runtime decisions with `PluginHookError`.
Plugin hook names use lowercase dotted paths, including
`provider.request.before`, `provider.response.after`,
`thread.compaction.before`, `thread.compaction.after`, `tool.call.before`, and
`turn.start.before`.

Replace the root `Agent` constructor and `Agent.create()` surface with the async
`createAgent()` factory. `Agent` remains available as a type, while all plugin
factories finish initialization before `createAgent()` resolves.

Flatten event-backed plugin hook payloads so handlers receive their narrowed
event directly, and expose `registerTool()` as the tool capability helper.
