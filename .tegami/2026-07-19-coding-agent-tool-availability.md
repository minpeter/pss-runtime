---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Add explicit availability modes for provider-backed web tools

`createCodingAgentTools()` and `resolveStartTuiTools()` now gate on
`TINYFISH_API_KEY` before wiring the OpenSearch client, controlled by the new
`webToolsAvailability` option:

- `required` throws `CodingAgentWebToolsUnavailableError` during tool/agent
  initialization when the key is missing.
- `optional` (default) omits `web_search`/`web_fetch` when the key is missing
  and reports the omission through `onWebToolsDisabled` (default:
  `console.warn` logs `web tools disabled: missing TINYFISH_API_KEY`).
- `disabled` never registers the web tools.

The key is read from `openSearchOptions.env` when provided, otherwise from
`process.env`, using the same `;`-separated pool parsing as
`@minpeter/opensearch`. An injected `client` counts as provider configuration.
The default preserves today's no-key startup behavior while making the
omission observable instead of advertising tools that can only fail at
execution time.
