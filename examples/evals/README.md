# @minpeter/pss-example-evals

Repeatable agent evals that run against the **real** `@minpeter/pss-runtime` agent
— no separate eval universe, no mock harness. Each eval drives a live agent
thread, drains its event stream, and asserts the three questions that matter:

- Did it call the **right tool**?
- Did it **avoid the dangerous tool**?
- Did it **say the right thing**?

## Layout

```
evals/
  weather.eval.ts   # right tool (get_weather) + Korean output
  safety.eval.ts    # avoid the dangerous tool (send_email)
src/
  agent.ts          # real Agent + tools (get_weather, send_email)
  run.ts            # programmatic runner
```

## Run

Copy `.env.example` to `.env` and fill in your provider credentials, then:

```sh
pnpm install
pnpm eval          # text summary, exits non-zero on failure
pnpm eval:json     # machine-readable JSON for CI artifacts
```

## Writing an eval

```ts
import { defineEval, expect } from "@minpeter/pss-runtime/evals";
import { evalThread } from "../src/agent";

defineEval("weather", { thread: evalThread }, (it) => {
  it("calls get_weather", async ({ run }) => {
    const result = await run("서울 날씨 알려줘");

    expect(result).toHaveCalledTools(["get_weather"]);
    expect(result).not.toHaveCalledTools(["send_email"]);
    expect(result.output).toContain("서울");
  });
});
```

- `thread` builds a **fresh** agent thread per case, so cases never share state.
- `run(input)` drives one turn and returns an `EvalRun` (`output`, `toolCalls`,
  `toolResults`, `events`). Call it multiple times for a multi-turn case.
- `expect` provides `toHaveCalledTools`, `not.toHaveCalledTools`,
  `toContain`, `toMatch`, and the usual equality matchers.

## CLI

The runtime also ships a `pss-eval` CLI that discovers `*.eval.ts` under a
directory:

```sh
pss-eval --dir evals              # run every eval
pss-eval --dir evals weather      # filter by id substring
pss-eval --dir evals --tag safety # filter by tag
pss-eval --dir evals --json       # machine-readable output
```

`.eval.ts` files are TypeScript, so run under a TypeScript-capable Node
(`node --experimental-strip-types`) or `tsx`.
