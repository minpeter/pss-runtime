import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baselineProblems,
  binProblems,
  cliBuiltDocsProblems,
  cliCommandFacts,
  DOCUMENTED_COMMANDS,
  errorContractProblems,
  gitignoreProblems,
  packageProblems,
  routerProblems,
  trackedOutputProblems,
} from "./cli-built-docs.mjs";
import {
  BUILT_PROBE,
  CLI_BIN,
  cliDocProblems,
  EXEC_OPTION_ERROR_MESSAGE,
} from "./cli-built-docs-text.mjs";

// Built-CLI documentation agreement (VAL-CROSS-009..011): the README and
// coding-agent guidance must name the built CLI path, the help/error
// commands, the build-before-probe ordering, and the closed-loop boundary,
// and those claims must match the package bin entrypoints, the bin shim,
// the router, the error sources, the bundle baseline, and the ignore rules.

const VALID_BIN = `#!/usr/bin/env node
import { runCodingAgentCli } from "../dist/cli.js";
import {
  formatModelEnvSetupHelp,
  isModelEnvValidationError,
} from "../dist/env.js";

try {
  const exitCode = await runCodingAgentCli();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} catch (error) {
  if (isModelEnvValidationError(error)) {
    process.stderr.write(formatModelEnvSetupHelp(error));
  }
  process.exitCode = 1;
}
`;

const VALID_PACKAGE = {
  bin: { pss: "./bin/pss.js", "pss-coding-agent": "./bin/pss.js" },
  files: ["dist", "bin", "README.md"],
};

const VALID_BASELINE = {
  artifacts: {
    "apps/coding-agent/dist/cli.js": 100,
    "apps/coding-agent/dist/env.js": 100,
  },
};

const FULL_DOC = [
  "Run `pnpm build` first, then probe the built output:",
  `\`${BUILT_PROBE}\` exits 0; \`pss exec --help\` prints usage.`,
  `Invalid options exits 1 with \`${EXEC_OPTION_ERROR_MESSAGE}\`.`,
  "The probes are closed-loop: no provider credential and no listening port.",
].join("\n");

const realRead = (path) => readFileSync(path, "utf8");

describe("built-CLI docs agreement (VAL-CROSS-009..011)", () => {
  it("shipped docs, entrypoints, baseline, and ignore rules agree", () => {
    expect(cliBuiltDocsProblems()).toEqual([]);
  });

  it("the real bin shim imports only the two dist modules", () => {
    expect(binProblems(realRead(CLI_BIN))).toEqual([]);
  });

  it("the real router usage lists exactly the documented entrypoints", () => {
    const facts = cliCommandFacts(realRead("apps/coding-agent/src/cli.ts"));
    expect([...facts.usageCommands].sort()).toEqual(
      [...DOCUMENTED_COMMANDS].sort()
    );
    expect(routerProblems(facts)).toEqual([]);
  });

  it("flags a bin entrypoint that drifts from the documented path", () => {
    expect(
      packageProblems({ ...VALID_PACKAGE, bin: { pss: "./bin/cli.mjs" } })
    ).not.toEqual([]);
    expect(packageProblems(VALID_PACKAGE)).toEqual([]);
  });

  it("flags a bin shim that imports a source module instead of dist", () => {
    const stale = VALID_BIN.replace("../dist/cli.js", "../src/cli.ts");
    const problems = binProblems(stale);
    expect(problems.join("\n")).toContain("dist");
    expect(binProblems("#!/usr/bin/env node\n")).not.toEqual([]);
  });

  it("flags a router whose help listing drifts from the documented set", () => {
    const facts = cliCommandFacts(realRead("apps/coding-agent/src/cli.ts"));
    expect(
      routerProblems({
        usageCommands: [...facts.usageCommands, "serve"],
        dispatchCommands: facts.dispatchCommands,
      }).length
    ).toBeGreaterThan(0);
    expect(
      routerProblems({
        usageCommands: facts.usageCommands,
        dispatchCommands: [],
      }).length
    ).toBeGreaterThan(0);
  });

  it("flags a lost static exec error or setup-help mapping", () => {
    const valid = {
      execCliSource: `throw new ExecOptionError(); // ${EXEC_OPTION_ERROR_MESSAGE} 1200`,
      envSource: "export const formatModelEnvSetupHelp = 1;",
      binSource: VALID_BIN,
    };
    expect(errorContractProblems(valid)).toEqual([]);
    expect(
      errorContractProblems({ ...valid, execCliSource: "throw new Error();" })
    ).not.toEqual([]);
    expect(
      errorContractProblems({
        ...valid,
        binSource: VALID_BIN.replaceAll("isModelEnvValidationError", "other"),
      })
    ).not.toEqual([]);
  });

  it("flags a bundle baseline that drops the CLI dist modules", () => {
    expect(baselineProblems(VALID_BASELINE)).toEqual([]);
    expect(
      baselineProblems({ artifacts: { "apps/coding-agent/dist/cli.js": 1 } })
    ).not.toEqual([]);
  });

  it("flags tracked or unignored build output", () => {
    expect(gitignoreProblems("dist\n.turbo\n")).toEqual([]);
    expect(gitignoreProblems(".turbo\n")).not.toEqual([]);
    expect(trackedOutputProblems("")).toEqual([]);
    expect(
      trackedOutputProblems("apps/coding-agent/dist/cli.js\n")
    ).not.toEqual([]);
  });

  it("flags docs missing the built path, ordering, contract, or boundary", () => {
    expect(cliDocProblems("d", FULL_DOC, { full: true })).toEqual([]);
    expect(
      cliDocProblems("d", FULL_DOC.replace(CLI_BIN, "bin/pss.js"), {
        full: true,
      }).length
    ).toBeGreaterThan(0);
    expect(
      cliDocProblems("d", FULL_DOC.replace("`pnpm build` first", "later"), {
        full: true,
      }).length
    ).toBeGreaterThan(0);
    expect(
      cliDocProblems("d", FULL_DOC.replace(EXEC_OPTION_ERROR_MESSAGE, "x"), {
        full: true,
      }).length
    ).toBeGreaterThan(0);
    expect(
      cliDocProblems("d", FULL_DOC.replace("no listening port", "a port"), {
        full: true,
      }).length
    ).toBeGreaterThan(0);
    expect(
      cliDocProblems("d", "node apps/coding-agent/src/cli.ts --help", {
        full: false,
      }).length
    ).toBeGreaterThan(0);
    expect(cliDocProblems("d", undefined, { full: true })).toEqual([
      "d is missing",
    ]);
  });
});
