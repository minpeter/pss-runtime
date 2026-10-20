---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Fix Durable Object payload chunking hang on emoji

Chunking an oversized Durable Object payload or thread message no longer loops forever when a surrogate pair (for example an emoji) straddles a chunk boundary probe; the two duplicated chunkers now share one implementation.
