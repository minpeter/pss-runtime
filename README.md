<p align="center">
  <img src="assets/runtime-banner.png" alt="Plugsuits banner" width="100%" />
</p>

# Plugsuits

> Just want the terminal agent? [`apps/coding-agent`](apps/coding-agent/README.md)
> opens with the install steps for the `pss` TUI and the `pss exec` runner.

Small agent runtime workspace, and the successor to
[minpeter/plugsuits](https://github.com/minpeter/plugsuits). Everything ships
under the `pss` prefix, short for Plugsuits.

- [`@minpeter/pss-runtime`](packages/runtime/README.md): runtime, threads,
  model loop, core hooks, storage, and instrumentation.
- [`@minpeter/pss-coding-agent`](apps/coding-agent/README.md): model wiring,
  workspace coding tools, the `pss` TUI, and the `pss exec` headless runner.

## Use

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";

const provider = createOpenAICompatible({
  name: "custom",
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
});

const agent = await createAgent({
  instructions: "Keep every answer under 3 lines.",
  model: provider(process.env.AI_MODEL ?? "minimax/MiniMax-M3"),
});

const thread = agent.thread("default");
const turn = await thread.send("Hello");

for await (const event of turn.events()) {
  console.dir(event, { depth: null });
}
```

`turn.events()` drives the turn. The runtime waits at `turn-start`,
`step-start`, and `step-end` until the consumer continues, so consume the
events to let the turn progress.

## Development

Requires Node 24 and pnpm 11.9; run `pnpm install --frozen-lockfile` after
cloning. The local quality gate runs entirely offline:

- `pnpm lint` / `pnpm typecheck` — static analysis and project checks.
- `pnpm test` — package tests plus the repository invariant suite.
- `pnpm build` / `pnpm coverage` — full workspace build and the coverage gate.
- `pnpm api:check` / `pnpm verify:edge` — runtime API snapshot check and the
  Worker edge-bundle dry run.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the QA and evidence rules and the
[operational runbooks](docs/runbooks/README.md) for CI triage, release, and
local Worker validation procedures.

## Operational boundaries

Some readiness controls are external-only: they cannot be configured or
verified from repository files or local commands, so this repository documents
them as deferred rather than claiming them as active:

- Branch protection enforcement on GitHub is deferred and external; the
  repository ships advisory [CODEOWNERS](.github/CODEOWNERS) instead.
- Native GitHub secret scanning is deferred and external; the repository-local
  substitute is the deterministic secret-pattern scan collected by
  `pnpm test`.
- Hosted analytics and hosted error tracking such as Sentry are deferred and
  external, and hosted alerting such as PagerDuty is likewise deferred; no
  hosted backend is wired up here.
- Progressive rollout and automated rollback are deferred and external;
  releases follow the [release runbook](docs/runbooks/release-procedure.md)
  only.
- Production deployment and health monitoring of the Worker are deferred and
  external; the local counterpart is the
  [worker-health runbook](docs/runbooks/worker-health.md).

## Security

Found a vulnerability? Follow the [security policy](SECURITY.md) to report it
privately through GitHub's built-in private vulnerability reporting.

## License

This project is licensed under the [Sustainable Use License](LICENSE.md).

You can use, modify, and distribute it for free for internal business,
non-commercial, or personal use. Reselling it or offering it as a paid product
or service requires a separate commercial license.
