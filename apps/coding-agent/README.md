# @minpeter/pss-coding-agent

Model wiring and the `pss` TUI for pss-next. The TUI includes OpenSearch-backed
`web_search` and `web_fetch` tools by default when `TINYFISH_API_KEY` is
configured.

```ts
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import { createAgent } from "@minpeter/pss-runtime";

const agent = await createAgent({
  model: createCodingLanguageModel(),
});

const turn = await agent.send("Hello from pss");
for await (const event of turn.events()) {
  console.dir(event, { depth: null });
}
```

`turn.events()` is synchronized and drives the turn. The runtime waits at
`turn-start`, `step-start`, and `step-end` until the events consumer continues,
so consume the events to let the turn progress. Use `thread.send(input)` for a
new user turn and `thread.steer(input)` to steer the active turn. If no turn is
active, `thread.steer(input)` starts a normal turn.

```ts
const thread = agent.thread("default");
const turn = await thread.send("Explain the latest result.");
let askedForExample = false;

for await (const event of turn.events()) {
  if (event.type === "step-end" && !askedForExample) {
    askedForExample = true;
    await thread.steer("Add one concrete example.");
  }
}
```

Guard `step-end` additions. Runtime input added at `step-end` intentionally
continues the current turn before the next model snapshot, even if the assistant
already printed final-looking text. Adding input on every `step-end` can keep
the turn running indefinitely.

Steered additions emit `runtime-input`: runtime/API-originated input mapped
internally to the model's user role, separate from human `user-input` events.

## CLI

```sh
pnpm dlx @minpeter/pss-coding-agent
```

```sh
pnpm add -g @minpeter/pss-coding-agent
pss
```

CLI commands: `pss`, `pss-coding-agent`.

Update a global install, or preview what an update would do:

```sh
pss update
pss update --check
```

`pss update` re-checks the npm registry's dist-tags and installs the exact
newest version of your channel through the detected package manager
(pnpm/npm/bun/yarn global installs). Your channel follows the installed
version: stable installs track `latest`, and a prerelease like `0.0.14-next.2`
or `1.0.0-beta.3` tracks its own dist-tag (`next`, `beta`, or any published
tag). Moving to stable is explicit:

```sh
pss update --channel latest
```

Any other published dist-tag can be targeted the same way (`pss update
--channel beta`); moving a stable install to a prerelease channel is refused,
and an unknown channel reports the published channel list.

One-off runs (`pnpm dlx`, `npx`, `bunx`) cannot be updated in place; `pss
update` prints the global install command instead.

Inspect the configured local thread without starting the TUI:

```sh
pss inspect-thread
```

The inspection command uses the runtime Node adapter to decode stored thread
snapshots, so the CLI reports the same file path, message count, compaction
records, and version that runtime storage uses.

Run one headless coding task (CI, benchmarks, scripts):

```sh
pss exec --workspace . --prompt "Fix the failing test"
pss exec --workspace . --stdin --timeout-seconds 900 --result-file result.json
```

`pss exec` streams JSONL events (`metadata`, `agent_event`, `result`) to stdout
and exits 0 only when the task completes. Flags: `--workspace`; exactly one of
`--prompt`, `--prompt-file`, or `--stdin`; plus `--model`, `--base-url`,
`--timeout-seconds` (1-1200), `--web-tools`, and `--result-file`. A `.env` next
to the working directory is loaded automatically.

Both the TUI and `pss exec` share the same workspace tools through
`createCodingAgent`: `read_file`, `glob_files`, `grep_files`, `edit_file`
(hashline-anchored), `write_file`, `delete_file`, and `shell_execute`. The file
tools are confined to the workspace (path and symlink escapes are rejected).
`shell_execute` is not a sandbox — commands run with the user's permissions,
but AI provider API keys are withheld from the child environment. Untrusted
workloads belong in a container (see `benchmarks/nextjs`, which runs the agent
in Docker).

Pass `tools` to `startTui` (or `createCodingAgent`) from a custom entrypoint to
replace the optional web tools; the workspace tools are always included.

## Updates

The TUI checks for updates without blocking startup. The cached result in
`~/.pss/update-check.json` (24h TTL) is read before the first render; when it
names a newer version on your channel (or a stable release that surpasses a
prerelease install), one dim line is printed into the scrollback, and a stale
cache is refreshed in the background for the next run. Checks are skipped for
dev/source runs. Set `PSS_DISABLE_UPDATE_CHECK=1` (or `true`) to opt out.

### Auto-update (opt-in)

Set `PSS_AUTO_UPDATE=1` (or `true`) to let pss update itself: when the cached
check names a newer version on your channel and the install is a confidently
detected global install (path-based pnpm/npm/bun/yarn layout), the exact
pinned version is installed after the TUI exits — never during a session,
never across a major version, and never as a channel switch. Ephemeral and
unrecognized installs are skipped, and `PSS_DISABLE_UPDATE_CHECK=1` disables
auto-update as well.

## Web tools availability

The web tools are backed by `@minpeter/opensearch` and need `TINYFISH_API_KEY`
(one or more `;`-separated keys). `createCodingAgentTools()` gates on the key
before wiring the OpenSearch client, controlled by `webToolsAvailability`:

- `optional` (default): when the key is missing, the web tools are omitted
  instead of advertised, and the omission is reported through
  `onWebToolsDisabled` (default: `console.warn` logs
  `web tools disabled: missing TINYFISH_API_KEY`; the `pss` TUI overrides the
  handler and renders the message as a dim scrollback line at startup).
  Startup still succeeds, so environments without a key behave exactly as
  before minus the unusable tools.
- `required`: throw `CodingAgentWebToolsUnavailableError` during tool/agent
  initialization when the key is missing, so a model can never be offered a
  tool that cannot execute.
- `disabled`: never register the web tools.

The key is read from `openSearchOptions.env` when provided, otherwise from
`process.env`. An injected `client` counts as provider configuration in
`optional` and `required` modes.

```ts
const tools = createCodingAgentTools({ webToolsAvailability: "required" });

// Custom entrypoint around the TUI defaults:
const tuiTools = resolveStartTuiTools(undefined, {
  webToolsAvailability: "required",
});
```

When the TUI is idle, submitting text starts a normal `thread.send()` turn. When
a run is active, submitting text calls `thread.steer(trimmed)` so the text lands
in the current turn and renders as dim `runtime: ...` input instead of a new human
turn.

## Env

Set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` for the model.

The TUI persists runtime-owned thread state to files by default:

- `PSS_THREAD_DIR` overrides the store directory. Default: `~/.pss/threads`.
- `PSS_THREAD_KEY` overrides the conversation key. Default: `cwd:<current working directory>`.

Local auto-compaction is disabled unless both thresholds are set:

- `PSS_AUTO_COMPACTION_MIN_MESSAGES` starts compaction once stored history reaches this count.
- `PSS_AUTO_COMPACTION_RETAIN_MESSAGES` keeps this many newest messages outside the summary.

Both values must be positive integers, and retain messages must be smaller than
minimum messages.

Examples:

```sh
pss
PSS_THREAD_KEY=workspace:demo pss
PSS_THREAD_DIR=.pss/threads pss
PSS_AUTO_COMPACTION_MIN_MESSAGES=24 PSS_AUTO_COMPACTION_RETAIN_MESSAGES=8 pss
PSS_THREAD_KEY=workspace:demo pss inspect-thread
```

## Dev

```sh
pnpm dev:tui
```
