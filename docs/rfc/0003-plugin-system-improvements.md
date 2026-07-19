---
source_issue: 213
source_url: https://github.com/minpeter/pss-runtime/issues/213
original_created_at: 2026-07-19
status: Proposed
---

> Moved from GitHub issue #213 into the repo on 2026-07-19; the issue is closed and this file is the canonical copy.

# RFC 0003: Plugin System Improvements (Pi Harness Gap Analysis)

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Authors** | @minpeter |
| **Created** | 2026-07-19 |
| **Target packages** | `@minpeter/pss-runtime` (plugin kernel), optionally `apps/coding-agent` / `apps/worker-agent` for harness-layer surfaces |
| **Related** | Current plugin docs in `packages/runtime/README.md#plugins`; Pi extensions: [extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) |

---

## Summary

`@minpeter/pss-runtime` already ships a solid **factory plugin kernel**: async `definePlugin`, typed `on()` lifecycle hooks, `provide()` capabilities (`registerTool`, `threadScope`), fail-closed decisions, and registration-order transform chaining.

Compared to the [Pi coding agent extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), that kernel is still a **lifecycle middleware slice**, not a full extension host. Product plugins that Pi packages routinely ship (permission UX, dynamic tools, system-prompt injection, session-persisted extension state, interactive approval, message/tool rendering) either cannot be built on pss plugins today or must be reimplemented outside the plugin API.

This RFC inventories those gaps, proposes a layered capability roadmap that keeps runtime core an embed kernel, and recommends phased work so harness features (slash commands, TUI, skills) do not leak into the runtime.

---

## Goals

- Close **kernel-relevant** gaps so reusable policies (approval, sanitize, RAG inject, tool governance, compaction policy) can live as portable plugins.
- Keep HTTP/TUI/slash-command/skills/themes in **app/harness layers** (`coding-agent`, `worker-agent`), not in runtime core.
- Preserve current invariants: fail-closed hooks, structured-cloneable payloads, no public rewrite of persisted history via ephemeral context hooks.
- Make capability growth explicit via `provide()` (or a versioned capability registry) instead of an unbounded `PluginAPI` surface dump.

## Non-Goals

- Cloning Pi packages, themes, or AGENTS.md discovery into `@minpeter/pss-runtime`.
- Making plugins a general host/storage/scheduler replacement API.
- Exposing SessionManager-style full session tree mutation from every hook.
- Embedding a TUI UI toolkit in the runtime package.

---

## Current State (pss-runtime)

Public plugin surface today:

```ts
definePlugin(async (pss, { signal }) => {
  pss.on(event, handler);              // typed lifecycle
  pss.provide(registerTool({ ... }));  // tools at init only
  pss.provide(threadScope(() => T));   // in-memory per-thread state
});
```

| Area | Support |
|------|---------|
| Input intercept | `input.accept` → continue / transform / handled |
| Turn / step / message | Mostly observe-only (`turn.*`, `step.*`, `message.*`) |
| Model context | `model.context` ephemeral transform (not stored history) |
| Model step | `model.step.before` transform before history append |
| Provider | `provider.request.before` transform; `provider.response.after` observe |
| Tools | `tool.call.before` block / needs-recovery (no input transform); `tool.result` transform |
| Compaction | `thread.compaction.before` continue / transform / cancel |
| State | `threadScope` in-memory only; cleared on thread dispose |
| Context in handlers | `{ history, signal, thread: { key } }` only |

Reference: `packages/runtime/src/plugins/api.ts`, `packages/runtime/src/plugins/runtime.ts`.

---

## Reference: What Pi Extensions Can Do

Pi’s `ExtensionAPI` is a **harness extension host**. Notable surfaces beyond lifecycle hooks:

| Pi capability | Notes |
|---------------|--------|
| Rich `ExtensionContext` | `ctx.ui`, `sessionManager`, `modelRegistry`, `model`, `signal`, `isIdle`, `abort`, `compact`, `getSystemPrompt`, … |
| Interactive permission UX | `ctx.ui.confirm` / `select` / `input` from `tool_call` |
| Tool input mutation | `event.input` mutable in place on `tool_call` |
| System prompt / inject | `before_agent_start` → `systemPrompt`, persistent `message` inject |
| Dynamic tools | `registerTool` after startup; `setActiveTools` |
| Commands / shortcuts / flags | `/cmd`, keybindings, CLI flags |
| Session-persisted extension data | `appendEntry` (not in LLM context) + optional renderers |
| Custom compaction summary | `session_before_compact` can supply summary, not only cancel |
| Message rewrite | `message_end` can replace finalized message (same role) |
| Tool progress | `tool_execution_update` stream events |
| Agent drive from extension | `sendMessage` / `sendUserMessage` (steer / followUp / nextTurn) |
| Provider headers | `before_provider_headers` mutate headers |
| Resource discovery | skills / prompts / themes paths |
| Hot reload | `/reload` rebinds extensions |
| Package ecosystem | npm/git pi packages bundling extensions + skills + themes |

Sources: [Pi extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [pi.dev](https://pi.dev/).

---

## Gap Analysis

Legend: **R** = runtime kernel candidate · **H** = harness/app layer · **?** = design choice needed

### P0 — Blocks common product plugins

| # | Gap | Layer | Pi | pss today | Why it matters |
|---|-----|-------|-----|-----------|----------------|
| G1 | **Interactive / async host bridge in tool hooks** | R + H | `ctx.ui.confirm` from `tool_call` | No host UI bridge; only `block` / `needs-recovery` | Real approval UX needs “pause tool, ask user, resume” without hard-coding the UI in the runtime |
| G2 | **Tool argument transform** | R | mutate `event.input` | Snapshotted; transform invalid on `tool.call.before` | Path rewrite, env injection, arg sanitization, secret redaction before execute |
| G3 | **System / instructions injection** | R | `before_agent_start` systemPrompt + message inject | Only ephemeral `model.context` | Per-turn policy, skill snippets, tenant rules without constructor rewrite |
| G4 | **Dynamic tool registration / active set** | R | runtime `registerTool` + `setActiveTools` | Tools only during factory; no active-set API | Mode switches (plan/exec), MCP attach, per-thread tool allowlists |
| G5 | **Plugin-driven control actions** | R | `sendUserMessage`, `sendMessage`, `compact`, `abort` | Plugins cannot steer/send/compact | Supervisors, watchdogs, loop-breakers, post-tool follow-ups |

### P1 — Portable policy quality

| # | Gap | Layer | Pi | pss today | Why it matters |
|---|-----|-------|-----|-----------|----------------|
| G6 | **Richer PluginEventContext** | R | large ctx surface | `{ history, signal, thread.key }` | Policies need usage, model id, active tools, compaction budget, turn id |
| G7 | **Custom compaction summary** | R | return summary payload | cancel / transform input only | App-owned compaction quality without forking runtime |
| G8 | **Message / tool-result post-process depth** | R | `message_end` replace; richer `tool_result` | `message.*` observe-only; `tool.result` transform only | Cost annotation, injection scan of tool output, redaction before model sees it |
| G9 | **Tool execution progress events** | R | `tool_execution_update` | start/end only | Long tools (shell, browser) need partial UX / telemetry |
| G10 | **Durable plugin state** | R? | `appendEntry` | `threadScope` memory only | Checkpoints, approval audit, todo lists that survive process restart |
| G11 | **Provider header / transport hooks** | R | `before_provider_headers` | params transform only (via middleware) | Gateway tracing, tenant headers, attribution |

### P2 — Harness surfaces (keep out of runtime core)

| # | Gap | Layer | Notes |
|---|-----|-------|-------|
| G12 | Slash commands / shortcuts / CLI flags | H | `coding-agent` concern; runtime stays embeddable |
| G13 | Skills / prompt templates / themes discovery | H | Resource packs; optional future “resource provider” capability if needed |
| G14 | TUI renderers / widgets / status line | H | `pi-tui` already used by coding-agent; inject via host bridge, not runtime |
| G15 | Session tree fork/switch/tree events | H + host | Session UX on top of durable threads; may need thin runtime notifications later |
| G16 | Hot reload / package install | H | Dev UX for coding-agent, not DO workers |
| G17 | Project trust model | H | Local FS agent security story |

---

## Design Principles

1. **Kernel vs harness split**  
   Runtime plugins own *agent-loop boundaries*. Harness plugins own *product UX* (commands, TUI, skills). Bridge them with small, typed host ports.

2. **Capabilities over mega-API**  
   Prefer `pss.provide(hostUiPort(...))`, `pss.provide(threadControl(...))` over dumping every method on `PluginAPI`. Unknown capability kinds stay fail-closed.

3. **Fail-closed + clone safety**  
   Keep structured clone of request payloads. If tool-arg transform is added, define explicit `action: "transform"` with validated args (do not silently accept in-place mutation).

4. **Do not reopen persisted-history rewrite**  
   Ephemeral `model.context` stays non-persistent. Durable history repair remains a versioned recovery job (existing README contract).

5. **Durable recovery already exists — productize the host side**  
   `tool.call.before` → `needs-recovery` is a strong primitive. Gap G1 is mostly **host-facing resume UX**, not a new checkpoint system.

---

## Proposed Direction

### A. Runtime kernel (`@minpeter/pss-runtime`)

#### A1. Extensible capability registry (foundation)

- Keep `on` / `provide` kernel.
- Document and version capability kinds beyond `tool` and `thread-scope`.
- Allow host apps to inject ports at `createAgent` time that plugins consume via `provide` or factory context.

Sketch:

```ts
const agent = await createAgent({
  model,
  plugins: [approvalPlugin, ragPlugin],
  pluginHost: {
    // app-owned ports; runtime only type-checks / forwards
    ui: workerUiBridge,
    control: threadControlBridge,
  },
});
```

#### A2. Tool call request upgrade (G2, partial G1)

Extend `tool.call.before` decisions:

```ts
| { action: "continue" }
| { action: "block"; reason?: string }
| { action: "needs-recovery" }
| { action: "transform"; input: unknown }   // NEW — validated / cloned
// optional later:
| { action: "defer" }                       // alias or structured needs-recovery
```

Invariants:

- Transform chains in registration order (like other request hooks).
- Input remains structured-cloneable.
- Mutations that plugins make on the *event object itself* still do not leak (keep snapshotting).

#### A3. Turn prelude hook (G3)

Add a request hook before the first model call of a turn, e.g. `turn.prelude` / `agent.start.before`:

```ts
pss.on("turn.prelude", (event, ctx) => ({
  action: "transform",
  value: {
    instructionsDelta?: string,          // append or replace policy TBD
    prependMessages?: ModelMessage[],  // ephemeral vs durable TBD
  },
}));
```

Open design choice: ephemeral-only (like `model.context`) vs durable inject. Default recommendation: **ephemeral instructions delta + optional durable user/runtime input via normal send/steer APIs**, not silent history writes.

#### A4. Dynamic tools (G4)

- Allow `registerTool` subscriptions to activate after factory close *or* provide `tools.setActive(names)` host API on `Agent`/`ThreadHandle`.
- Per-thread tool overlays should compose with constructor tools without name conflicts.

#### A5. Thread control capability (G5)

Plugin-callable, host-mediated actions:

```ts
interface ThreadControl {
  steer(input: ThreadInput): Promise<void>;
  notify?(input: RuntimeInput): Promise<void>;
  compact?(opts?: { instructions?: string }): Promise<void>;
  abort?(): void;
}
```

Only available when the host installs the capability; worker DO / TUI supply different implementations.

#### A6. Context enrichment (G6)

Expand `PluginEventContext` with read-only snapshots:

- `turnId` / `runId` when available  
- `model` identity (provider/id if known)  
- `tools` active names  
- optional `usage` estimate  
- `meta` for input source already present on events  

Avoid passing mutable session stores.

#### A7. Compaction summary hook (G7)

Extend `thread.compaction.before`:

```ts
| { action: "cancel" }
| { action: "transform"; value: { input } }
| { action: "summarize"; value: { summary: string; /* retention markers */ } }
```

Keep summary producer app-owned; runtime validates and applies through existing compaction pipeline.

#### A8. Progress + provider headers (G9, G11)

- Emit observe-only `tool.execution.update` when tools report partial output (AI SDK `onUpdate` bridge).
- Either document that `provider.request.before` covers headers via params, or add explicit `provider.headers.before` if AI SDK middleware cannot express it cleanly.

#### A9. Durable plugin state (G10) — optional / later

Options (pick one in design review):

1. Host-owned `pluginStore` port: `get/set/delete(namespace, key)`  
2. Thread event custom entries (like Pi `appendEntry`) excluded from model mapping  
3. Stay out of runtime; apps use their own DO storage  

Recommendation: **(1) host port** first — zero new transcript protocol; works on memory/file/DO.

### B. Harness layer (`apps/coding-agent`, `apps/worker-agent`)

| Work | Maps to |
|------|---------|
| UI bridge implementing confirm/select/notify over TUI or Telegram | G1, G12–G14 |
| Slash commands / keybindings registry | G12 |
| Skills / prompt packs loader as ordinary plugins or pre-agent setup | G13 |
| `needs-recovery` → user approval → resume path productization | G1 |
| Optional package-style discovery for local plugins | G16 |

Do **not** wait for full Pi parity in the harness before shipping A2–A5 in the kernel.

---

## Worked Examples (target DX)

### Permission gate with host UI

```ts
const approval = definePlugin((pss) => {
  pss.on("tool.call.before", async (event, ctx) => {
    if (event.toolName !== "bash") return { action: "continue" };
    // Host port provided by coding-agent / worker-agent
    const ui = getHostUi(ctx); // via capability / AsyncLocal / factory capture
    const ok = await ui.confirm("Allow bash?", summarize(event.input));
    return ok
      ? { action: "continue" }
      : { action: "block", reason: "User denied bash" };
  });
});
```

Until UI ports exist, the same plugin can return `needs-recovery` and the host shows approval outside the plugin.

### Arg sanitization

```ts
pss.on("tool.call.before", (event) => {
  if (event.toolName !== "write_file") return;
  return {
    action: "transform",
    input: { ...asWrite(event.input), path: jailPath(asWrite(event.input).path) },
  };
});
```

### Ephemeral RAG / policy inject

```ts
pss.on("model.context", async ({ messages }, ctx) => ({
  action: "transform",
  value: { messages: await injectKnowledge(messages, ctx.thread.key) },
}));
```

---

## Implementation Plan

| Phase | Scope | Deliverable | Gate |
|-------|--------|-------------|------|
| **0** | Docs | Publish this gap matrix in docs; label each hook kernel vs harness | doc-only PR |
| **1** | A2 tool transform | `tool.call.before` `transform` + tests (clone, chain, no leak to execute from event mutation) | unit + agent integration tests |
| **2** | A6 context | Richer read-only `PluginEventContext` | type tests + no behavior change default |
| **3** | A3 prelude | Instructions / ephemeral inject hook | eval: policy plugin without constructor rewrite |
| **4** | A4 dynamic tools | Post-init tool register or active-set API | concurrent turn safety tests |
| **5** | A5 + host ports | `pluginHost` control + UI port contracts; coding-agent implements TUI confirm | approval E2E on coding-agent |
| **6** | A7 compaction summary | Optional summarize decision | compaction tests on memory + file host |
| **7** | A8 progress | `tool.execution.update` observe hook | worker observability plugin update |
| **8** | A9 durable state | Host `pluginStore` port (if still needed after 1–5) | DO + file host contract tests |

---

## Success Metrics

- Can implement **path-jail write tool**, **bash approval**, and **PII redact on tool results** as pure plugins with no Agent subclassing.
- Can switch **plan → exec tool sets** without recreating the Agent.
- Worker-agent observability plugin can attach run/turn ids from context without wrapping `send`.
- No new public API allows silent persisted-history corruption.
- Coding-agent can host Pi-like permission UX via host ports without moving TUI types into runtime.

---

## Open Questions

1. **Tool transform vs mutable input** — explicit `action: "transform"` (recommended) or Pi-style in-place mutation?
2. **Prelude durability** — are injected messages ephemeral-only, or may plugins enqueue durable `runtime-input`?
3. **Dynamic tools concurrency** — mid-turn tool set changes: freeze at turn start, or live update?
4. **Host port discovery** — factory context injection vs `pss.provide(requiredHostPort)` vs AsyncLocalStorage?
5. **`needs-recovery` productization** — is G1 primarily docs + worker/TUI resume UX, with UI-in-hook as a later nicety?
6. **Compaction summarize** — who owns the summarizer model call: plugin (may deadlock) or runtime with plugin-provided instructions?
7. **Capability versioning** — semver on capability kinds, or single runtime major bump per new kind?
8. **Scope of message transforms** — should `message.end` become a request hook, or remain observe-only with redaction only on `tool.result` / `model.step.before`?

---

## Out-of-Scope Follow-ups (explicit)

- Pi package registry / `pi install` equivalent  
- Built-in skills standard loader inside runtime  
- Session JSONL tree format parity  
- Games-in-TUI / custom entry renderers (pure harness)

---

## References

- pss plugin API: `packages/runtime/src/plugins/api.ts`
- pss plugin runtime: `packages/runtime/src/plugins/runtime.ts`
- pss plugin docs: `packages/runtime/README.md` (Plugins + Plugin event semantics)
- Example observe plugin: `examples/plugin`
- Worker observability plugin: `apps/worker-agent/src/observability.ts`
- Pi extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Pi product surface: https://pi.dev/
- Prior RFC style: #172
