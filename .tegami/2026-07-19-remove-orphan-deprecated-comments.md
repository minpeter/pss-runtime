---
packages:
  "npm:@minpeter/pss-runtime": patch
---

## Remove orphan `@deprecated` comments

Delete leftover deprecation comments after `SessionInput` and `FileSessionStore`
aliases were already removed. No API or behavior change.
