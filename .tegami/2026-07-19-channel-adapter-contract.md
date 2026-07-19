---
packages:
  npm:@minpeter/pss-runtime:
    type: minor
---

## Add the app-owned channel adapter contract

Expose `@minpeter/pss-runtime/channel` with typed inbound channel messages and
assistant text deliveries. Apps retain ownership of provider mapping, the
`Agent -> Thread -> Turn -> events()` control flow, and outbound delivery.

`projectChannelAssistantDelivery(event)` projects only non-empty
`assistant-output` events. The runtime does not add provider adapters or own a
channel loop.
