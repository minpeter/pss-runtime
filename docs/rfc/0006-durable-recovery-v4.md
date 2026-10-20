# RFC 0006: Durable recovery v4

- **Status:** Implemented
- **Date:** 2026-10-21
- **Scope:** `@minpeter/pss-runtime`, `@minpeter/pss-coding-agent`
- **Pull requests:** #468, #470, #471, #472, #473

## Summary

RFC 0005 made run ownership and terminal settlement safe. A crash still lost
more than it had to, though:

- recovery restored only committed history and the latest tool checkpoint, so
  a crash after several tool calls reran finished tools or parked the run;
- every tool without a policy parked the run for a person;
- ordinary turns ran without a lease, and leases were never renewed;
- nothing resumed a crashed turn unless something called `thread.continue()`
  or `agent.resume(runId)`.

This RFC records the five waves that close those gaps:

1. a step journal and step-end commits;
2. retry policies that settle unfinished calls, and `agent.resolveRecovery()`;
3. leases on every running turn, renewed and released by owner liveness;
4. backstops that resume crashed turns on hosts that wake on their own, plus
   the TUI's unfinished-turn notice;
5. a crash matrix that kills real processes.

## Evidence

The design compared three implementations, each read at a fixed commit:

| | pi (`pi-durable` 1.3.0, `48c8f32`) | fx (libfx SDK, `bc1e322`) | pss before (`f35785fb`) |
|---|---|---|---|
| Crash inside a tool | Commits intent, runs the effect, commits the outcome; reruns only `replay: "safe"` tools, otherwise reports `interrupted` | Every tool declares `idempotent`; reruns those under the same id, reports the rest as possibly partly run | Default `manual-recovery` parks the run |
| Crash mid-stream | Partial output committed at most every 100 ms | Streamed text is not saved; the model is asked again | The in-flight step is lost; the model is asked again |
| Resume | `harness.resume()` reopens everything | Queue redelivery; no app code | Explicit, one run at a time |
| Several processes | Unsupported; one process at a time | Lease of 15 s renewed every 5 s, with fencing | Fenced writes; 300 s lease, never renewed; normal turns unleased |
| Verification | In-process crash simulation, JSONL fault injection | SIGKILL crash matrix, TLA+ model | Contract suites, lost-response faults, chaos tests |

pss already had what neither keeps together: fenced checkpoints, a durable
input inbox, and terminal settlement in one transaction. It lacked step
granularity, per-tool crash semantics, live leases, and a resume trigger.

## Decisions

### Keep

- RFC 0005's lease-fenced transitions, fenced checkpoints, and atomic terminal
  settlement;
- thread history as the only committed conversation, in the same snapshot
  format;
- `manual-recovery` as the default for tools that declare no policy;
- platform-owned wake: the runtime schedules work, hosts decide how it fires;
- explicit resume as the baseline; automatic resume is an additive host
  capability.

### Add

#### Step journal and step-end commits (#468)

- At `step-end`, a durable run commits the finished tool round (assistant tool
  calls and their results) before the next model request.
- Each `before-tool` and `after-tool` checkpoint carries the step's journal
  (`runtimeState.journalVersion: 2`):
  - `inflight`: calls whose intent and input were recorded without an outcome;
  - `results`: finished outputs, or `errorText` for failed calls.
- Recovery rebuilds the turn from committed history plus the journal's
  uncommitted results, ordered by `seq`. `priorResultCount` tells a committed
  result from a reused provider id. A finished call never runs again; an
  unreadable entry makes recovery fail closed.
- A recovered continuation commits the restored round before its first model
  request, so a second crash still finds it.
- `inspectDurableTurn()` reports `pendingToolCalls`.

#### Retry policies and recovery decisions (#470)

Unfinished calls are settled before the recovered turn's first model request.
Each outcome is journaled before its round commits.

| `retryPolicy` | After a crash |
|---|---|
| `pure` | Intent gets no checkpoint of its own; recorded with the step's next checkpoint, it runs again; a step of only pure calls is asked again |
| `idempotent` | Runs again with the same `idempotencyKey` (`${runId}:${toolCallId}`) and the next `attempt` |
| `interrupt` | The model receives an error result: the call was interrupted and may have partly run |
| `manual-recovery` (default) | The run parks as `needs-recovery` |

`agent.resolveRecovery(runId, { toolCalls?, otherwise? })` records `rerun`,
`interrupt`, or `result` decisions for a parked run's calls and requeues it in
one transaction. A decision is spent once its call starts, so a decided rerun
that crashes again parks again. The coding agent declares its tools:
`read_file`, `glob_files`, `grep_files`, `web_search`, and `web_fetch` are
`pure`; `edit_file`, `write_file`, `delete_file`, and `shell_execute` are
`interrupt`.

#### Live leases (#471)

- A turn takes its run's lease in the same write that makes the run
  `running`, and renews it every 100 s (`TURN_LEASE_RENEW_MS`; a lease lasts
  `TURN_LEASE_MS`, 300 s) with a compare-and-set on `{ leaseId, status }`.
- `TurnLease.owner` records the process that took the lease.
  `AgentHost.ownerLiveness.isGone(owner)` lets a claim name the lease as
  abandoned before it lapses (`ClaimTurnOptions.abandonedLeaseId`):
  - file hosts: same host name, and the pid is gone or now belongs to a
    process with another start time;
  - Durable Object hosts (Celld, Cloudflare): a lease from another isolate;
  - memory hosts and hosts without `ownerLiveness`: expiry only.
- A turn whose renewal or fenced write fails stops, writes nothing, reloads
  the committed thread, and emits `turn-error` with `THREAD_OWNERSHIP_LOST`.
- A fresh run's lease is attempt 1, so five claim attempts allow four
  recoveries before `needs-recovery`.

#### Backstops and the unfinished-turn notice (#472)

- `HostScheduler` gains optional `scheduleBackstop(runId, { runAfterMs,
  threadKey })` and `cancelBackstop(runId)`.
  - A turn schedules a check `TURN_BACKSTOP_DELAY_MS` (310 s) out when it
    starts, inside the start transaction when `tx.scheduler` provides it.
  - Settlement cancels the check in its own transaction.
- `runTurnBackstop(agent, runId)` decides a due check:
  - `done` when the run settled or parked;
  - `retry` 10 s past a live owner's lease, 10 s later when the thread is
    busy, or a full delay later when the agent could not resume the run;
  - `resumed` when the owner is gone or the run went back to `queued`.
- Celld implements backstops as `celld-backstop` scheduled-work rows behind
  the object's alarm, drained by `drainCelldScheduledWork`.
- The TUI never resumes on its own. When it opens an existing session, it
  says whether the last turn is interrupted (Enter continues), still running
  in another `pss` process, or waiting on a call that may have partly run.

#### Crash matrix (#473)

A child process runs a file-host turn and is `SIGKILL`ed in one of twelve
cases. Another process then continues the thread. The cases kill it:

- mid-stream;
- before and after the effect of a call under each policy;
- after a saved result;
- after a committed round;
- next to a finished sibling.

The matrix runs in the runtime suite, so CI runs it on every pull request.

### Reject

- persisting partial model output (pi's 100 ms commits): the write cost buys
  little, since the step is requested again anyway;
- a TLA+ model: a separate project's worth of work;
- resuming automatically in the TUI: the user may have stopped on purpose;
- automatic resume on hosts without a self-waking scheduler: the file host
  has no worker of its own, and the TUI covers it.

## Invariants

The crash matrix checks these after every kill:

1. The killed run itself completes; recovery creates no second run.
2. A first attempt comes from the killed process and every later attempt from
   recovery, all under the call's own idempotency key.
3. `interrupt` and `manual-recovery` calls apply their effect at most once.
4. A saved or committed result is never rerun or replaced.
5. Committed history holds one user message, pairs every tool call with
   exactly one result, and keeps none of a killed stream's partial text.

## Persisted data

All changes are additive:

- tool checkpoints carry `journalVersion: 2` journals; checkpoints without
  one take the previous recovery path;
- decisions are stored as `resolution` on journaled intents;
- leases carry `owner`; a lease without one frees only on expiry;
- Celld stores backstops under a new scheduled-work kind; older runtimes
  neither arm alarms for nor drain it, and thread deletion sweeps it.

Thread snapshots keep their encoding.

## Rollback

Each wave is independently revertible. A run that crashed under a journal
checkpoint needs this runtime to recover as described here. Committed thread
history and settled runs read the same on either side.

## Verification

- per-wave in-process tests: `agent-thread-step-journal`,
  `agent-thread-tool-recovery`, `agent-thread-lease-ownership`,
  `turn-backstop`;
- the shared store, lease, and scheduler contract suites across memory, file,
  Durable Object, Celld, and SQL queue hosts;
- the SIGKILL crash matrix (`platform/file/host/crash-matrix.test.ts`);
- the coding agent's real TUI, recorded through the web-terminal harness
  after killing a `pss` process mid-turn.

## Known limits

- Only Celld schedules backstops. Elsewhere a crashed turn waits for
  `thread.continue()` or `agent.resume(runId)`; Cloudflare Agents still
  recover their own fibers through `onFiberRecovered()`.
- The file store's `listByThreadKey` reads every stored run (about 0.25 ms
  each), and both `thread.continue()` and the TUI's notice for resumed
  sessions pay for it.
- `CheckpointPhase` still declares `before-notification`,
  `after-notification`, `before-child-run`, and `child-linked`, which no
  runtime path writes. They stay for wire compatibility.
