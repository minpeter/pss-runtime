# Dependency compatibility patches

## @vercel/agent-eval 2.2.1

The private Next.js benchmark supplies its own PSS agent definition and sandbox
runner. Version 2.2.1 ships the shared custom-definition orchestrator but its
package export map hides it. This exact-version patch exposes that existing
module as `@vercel/agent-eval/orchestrator`, including its shipped declarations.
It changes only the export map, not execution, validation, transcript context,
credential redaction, or sandbox lifecycle behavior.

The `runWithDefinition(definition, fixturePath, options)` signature is unchanged
from 1.4.0. New capability controls are opt-in; the benchmark does not request
bundled-skill isolation or cross-agent judging. Adapter tests exercise the real
exported runner's pre-abort path and self-judge configuration without a provider,
and the dry-run test loads the real benchmark entry point.

Remove this patch and switch the adapter import when an upstream release exposes
a supported custom-definition runner with equivalent behavior. Recheck the
contract and offline regressions before updating the pinned package version.
