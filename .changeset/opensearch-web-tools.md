---
"@minpeter/pss-coding-agent": minor
---

Replace TinyFish-only web tools with `@minpeter/pss-web-tools` backed by `@minpeter/opensearch`.

`WebSearchOutput` and `WebFetchOutput` now use opensearch-native structured JSON (`count`, `source`, `content`, per-URL `errors`) instead of TinyFish field names.