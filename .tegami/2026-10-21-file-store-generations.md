---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## File hosts stop growing per transaction and survive power loss

File host transactions now stage by hard-linking the committed files instead of copying the whole store, and remove superseded and crashed generation directories after each commit, so a store keeps one generation and its disk use tracks its data rather than its transaction count.

A committed transaction is flushed to disk before and after `.current-generation` switches, so a power loss leaves the store at the last committed transaction instead of pointing at unwritten files.
