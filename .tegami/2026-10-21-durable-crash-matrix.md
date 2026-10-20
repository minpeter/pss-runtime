---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Kill real processes in a crash matrix

Add a SIGKILL crash matrix to the runtime test suite. A child process runs a file-host turn and is killed at one of twelve points: mid-stream; before or after a tool's effect for each retry policy; after a saved result; after a committed tool round; and next to a finished sibling call. Another process then continues the thread. Each case checks that the same run completes, that only the policy's reruns happen under the call's idempotency key, and that committed history pairs every call with one result. Test-only; no package changes.
