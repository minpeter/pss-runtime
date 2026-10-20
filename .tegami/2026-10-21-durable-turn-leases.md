---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Live turns keep their runs

Every running turn now holds a lease on its run from the moment it starts and renews it while it runs, so another process can no longer take over a live turn. A crashed owner's run is reclaimed as soon as its host proves the owner gone (`AgentHost.ownerLiveness`): file hosts check the owning process on the same machine, so a restarted `pss` session continues at once, and Durable Object hosts treat earlier activations as gone; otherwise the lease lapses after 300 seconds. A turn that finds its run taken over stops immediately, writes nothing, and reports `turn-error` with code `THREAD_OWNERSHIP_LOST`. Run records now carry the lease and its owner, so Durable Object hosts configured with a very small `maxPayloadBytes` need room for them.
