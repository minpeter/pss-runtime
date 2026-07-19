---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Remove orphan `@deprecated` comments

Delete leftover deprecation comments after `SessionInput` and `FileSessionStore`
aliases were already removed. No API or behavior change.
