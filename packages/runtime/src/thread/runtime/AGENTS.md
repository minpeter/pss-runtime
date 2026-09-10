# thread/runtime

The runtime engine: queue drain, auto-compaction, and kill/cancellation live
here. This is the largest area in `packages/runtime`.

## Invariants

- Backpressure is deliberate: a turn whose events are not consumed never
  progresses. That is the flow-control contract, not a bug.
- No `index.ts` in this directory or its `thread/` siblings (handle, input);
  import concrete file paths.
- Auto-compaction behavior is pinned by the co-located
  `auto-compaction-*.test.ts` files; extend them when changing deadlines or
  deep-freeze behavior.
