---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Keep live leases from containers that share a host name

File hosts on Linux now record the boot id and PID namespace of a lease owner
and prove an owner gone only when both match this process, so containers or
pods sharing a data directory and host name no longer take over each other's
live turns.
