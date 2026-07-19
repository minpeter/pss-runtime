---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Remove cache-stable-tools evidence campaign and ghost references

Delete the root-level cache-stable-tools measurement apparatus: the
live-provider benchmark, the "independent" and "adversarial" verifiers, their
evidence/wire tests, and the checked-in `benchmarks/` evidence artifacts. This
was a network-dependent evidence campaign that hashed runtime source for a
"source-freeze" check rather than testing runtime behavior. The cache-stable
model-step feature itself (`prepareModelStep` contracts) is unchanged.

Drop the four `cache-stable-tools` npm scripts and remove the verifier from the
root `test` script. Remove ghost `!apps/bori-agent-backend` workspace and
tsconfig references to an app that does not exist.

Declare empty build outputs for `@minpeter/pss-worker-agent` (a
`wrangler deploy --dry-run` validation that produces no artifacts) so turbo no
longer warns about missing `dist/**` outputs.

No API or behavior change.
