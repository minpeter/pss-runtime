---
packages:
  "npm:@minpeter/pss-runtime": minor
---

## Drop legacy storage and namespace read-compat

Stop hydrating SQLite `legacy-json` thread-message chunk markers and stop
treating `:session:` owner namespaces as valid for ownership/resume.

Current chunk markers and `:thread:` owner namespaces only.
