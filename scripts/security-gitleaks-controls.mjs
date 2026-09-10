// Offline integration controls; supply the checksum-verified workflow binary.
// No downloads, commits, index updates, or unredacted scanner output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const RULE_HEADER = /^\[\[rules\]\]$/m;
const COMMITS = /^commits = \["[a-f0-9]{40}"\]$/gm;
const PATHS = /^paths = \[\x27{3}[^\n]+\]$/gm;
const VALUES = /\x27{3}\^([A-Za-z0-9_]+)\$\x27{3}/g;
const repository = process.cwd();
const binary = resolve(process.argv[2] ?? "gitleaks");
const version = spawnSync(binary, ["version"], { encoding: "utf8" });
assert.equal(version.status, 0, "Gitleaks binary must be available");
assert.equal(version.stdout.trim(), "8.30.1", "Use the workflow-pinned binary");
const config = readFileSync(".gitleaks.toml", "utf8");
const firstRule = config.search(RULE_HEADER);
assert.ok(firstRule > 0, "Historical rule allowlists must be present");
const prefix = config.slice(0, firstRule);
const history = config.slice(firstRule);
mkdirSync(".omo", { recursive: true });
const root = mkdtempSync(resolve(".omo/gitleaks-controls-"));

function scan(name, source, mode = "git", cwd = repository) {
  const configPath = join(root, `${name}.toml`);
  const report = join(root, `${name}.json`);
  writeFileSync(configPath, source);
  const result = spawnSync(
    binary,
    [
      mode,
      "--config",
      configPath,
      "--redact",
      "--report-format",
      "json",
      "--report-path",
      report,
      ".",
    ],
    { cwd, encoding: "utf8", timeout: 120_000 }
  );
  assert.ok(!result.error, `${name}: scanner execution error`);
  assert.ok(
    result.status === 0 || result.status === 1,
    `${name}: scanner failed`
  );
  const findings = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(
    result.status,
    findings.length === 0 ? 0 : 1,
    `${name}: exit status`
  );
  const fingerprints = findings.map((finding) => finding.Fingerprint).sort();
  console.log(`${name}: exit ${result.status}, ${findings.length} findings`);
  return { findings, fingerprints };
}

try {
  // Each mutation leaves the other two gates intact and scans real history.
  const baseline = scan("baseline", prefix);
  assert.equal(
    baseline.findings.length,
    38,
    "Re-triage changed historical findings"
  );
  assert.equal(scan("approved", config).findings.length, 0);
  const mutations = [
    [
      "wrong-commit",
      history.replace(COMMITS, `commits = ["${"0".repeat(40)}"]`),
    ],
    [
      "wrong-path",
      history.replace(PATHS, () => "paths = ['''^unapproved/file\\.txt$''']"),
    ],
    ["wrong-value", history.replace(VALUES, () => "'''^UNAPPROVED_VALUE$'''")],
  ];
  for (const [name, mutated] of mutations) {
    assert.notEqual(mutated, history, `${name}: mutation must apply`);
    const result = scan(name, prefix + mutated);
    assert.deepEqual(
      result.fingerprints,
      baseline.fingerprints,
      `${name}: all 38 exact findings must return`
    );
  }

  // Real-shaped but synthetic values, assembled only at runtime. The original
  // config must detect them even when inserted into reviewed paths.
  const fixtures = join(root, "fixtures");
  const paths = [
    "benchmarks/compaction-score/campaign-aggregation.test.ts",
    "scripts/verify-release-artifacts/runtime-public-surface.mjs",
  ];
  const alphabet = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7";
  const texts = [
    `api_key = "${alphabet.repeat(2)}"`,
    `cloudflare: "${"a1b2c3d4e5f6".repeat(4).slice(0, 40)}"`,
  ];
  for (const [index, path] of paths.entries()) {
    const target = join(fixtures, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, texts[index]);
  }
  const controls = scan("unapproved-credentials", config, "dir", fixtures);
  for (const [index, rule] of [
    "generic-api-key",
    "cloudflare-api-key",
  ].entries()) {
    assert.ok(
      controls.findings.some(
        (finding) =>
          finding.RuleID === rule && finding.File.endsWith(paths[index])
      ),
      `${rule}: synthetic unapproved credential must be detected`
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
