import { describe, expect, it } from "vitest";
import {
  BIOME_CONFIG,
  ciLintRuns,
  committedParityProblems,
  heavyCommandProblems,
  parityProblems,
  reachableCommands,
} from "./lint-parity.mjs";
import { readRepoFile } from "./precommit-hook.mjs";

// Local/CI lint parity (VAL-CROSS-003): the pre-commit lint-staged path and
// the CI lint gate apply the same Biome/Ultracite rule set from the single
// root biome.jsonc, differing only in scope (staged index set vs full tree),
// and no full-suite or service-start command is reachable from the hook.

const VALID = {
  lintScript: "ultracite check .",
  ciSource: [
    "jobs:",
    "  checks:",
    "    steps:",
    "      - name: Lint",
    "        run: pnpm lint",
  ].join("\n"),
  hookText: "pnpm exec lint-staged\n",
  mappings: [
    {
      pattern: "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,jsonc,css,graphql}",
      commands: ["pnpm exec ultracite fix"],
    },
  ],
  biomeConfigs: [BIOME_CONFIG],
  biomeSource: '{ "extends": ["ultracite/biome/core"] }\n',
};

describe("lint parity: local staged path vs CI full tree (VAL-CROSS-003)", () => {
  it("committed surfaces share one rule set and differ only in scope", () => {
    expect(committedParityProblems()).toEqual([]);
  });

  it("CI lint delegates to the same root script the hook binary enforces", () => {
    const { runs, error } = ciLintRuns(
      readRepoFile(".github/workflows/ci.yml")
    );
    expect(error).toBeNull();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).toBe("pnpm lint");
    }
  });

  it("accepts the canonical surfaces", () => {
    expect(parityProblems(VALID)).toEqual([]);
  });

  it("flags a divergent local binary or rule override", () => {
    expect(
      parityProblems({
        ...VALID,
        mappings: [{ pattern: "*.ts", commands: ["pnpm exec eslint --fix"] }],
      })
    ).not.toEqual([]);
    expect(
      parityProblems({
        ...VALID,
        mappings: [
          {
            pattern: "*.ts",
            commands: ["pnpm exec ultracite fix --config other.jsonc"],
          },
        ],
      })
    ).not.toEqual([]);
  });

  it("flags a staged command that widens scope to the full tree", () => {
    expect(
      parityProblems({
        ...VALID,
        mappings: [
          { pattern: "*.ts", commands: ["pnpm exec ultracite check ."] },
        ],
      })
    ).not.toEqual([]);
  });

  it("flags a CI lint step that bypasses the root script or diverges", () => {
    const direct = VALID.ciSource.replace(
      "pnpm lint",
      "pnpm exec ultracite check --config ci.jsonc ."
    );
    expect(parityProblems({ ...VALID, ciSource: direct })).not.toEqual([]);
    const absent = VALID.ciSource.replace(
      "run: pnpm lint",
      "run: pnpm typecheck"
    );
    expect(parityProblems({ ...VALID, ciSource: absent })).not.toEqual([]);
  });

  it("flags a non-ultracite or non-full-tree root lint script", () => {
    expect(parityProblems({ ...VALID, lintScript: "eslint ." })).not.toEqual(
      []
    );
    expect(
      parityProblems({ ...VALID, lintScript: "ultracite check" })
    ).not.toEqual([]);
  });

  it("flags a second biome config or a non-ultracite rule source", () => {
    expect(
      parityProblems({
        ...VALID,
        biomeConfigs: [BIOME_CONFIG, "apps/worker-agent/biome.jsonc"],
      })
    ).not.toEqual([]);
    expect(
      parityProblems({ ...VALID, biomeSource: '{ "extends": ["other"] }\n' })
    ).not.toEqual([]);
  });

  it("flags any non-lint-staged hook command", () => {
    expect(
      parityProblems({
        ...VALID,
        hookText: "pnpm exec lint-staged\npnpm typecheck\n",
      })
    ).not.toEqual([]);
  });

  it("no full-suite or service-start command is reachable from the hook", () => {
    const reachable = reachableCommands(VALID.hookText, VALID.mappings);
    expect(heavyCommandProblems(reachable)).toEqual([]);
    for (const heavy of [
      "pnpm test",
      "pnpm build",
      "pnpm coverage",
      "turbo run test",
      "pnpm dev:worker",
      "wrangler dev -e dev",
      "vitest run scripts/",
    ]) {
      expect(heavyCommandProblems([heavy])).not.toEqual([]);
    }
  });
});
