---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Allow explicit tool.call.before input transforms

`tool.call.before` handlers may return
`{ action: "transform", input }` to replace the arguments passed to tool
`execute`. Transforms chain in plugin registration order. Each handler still
receives a structured clone of the current event, so in-place mutation of the
event object does not affect later plugins or execution.

`continue`, `block`, and `needs-recovery` decisions are unchanged. A transform
missing `input`, or an input that is not structured-cloneable, fails closed
with `PluginHookError`.
