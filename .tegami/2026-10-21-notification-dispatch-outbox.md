---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Notifications schedule with their queued run

`dispatchAgentNotification` now schedules the thread wake inside the same store transaction that queues the notification when the host's transaction exposes `tx.scheduler` (memory, file, Durable Object storage, and Celld hosts), so a crash right after commit no longer leaves a queued notification nothing resumes. Hosts without `tx.scheduler`, such as `createCloudflareHost`, still schedule after commit.
