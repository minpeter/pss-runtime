import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

// Shared workspace version-drift helpers (VAL-SEC-010..014). Pure and
// static: no network, no ports, no writes, no clock. The executable wrapper
// lives in scripts/check-workspace-version-drift.mjs; the wrapper behavior
// tests live in scripts/check-workspace-version-drift.test.mjs.
//
// A drift is a declared dependency whose version ranges differ between two
// or more workspace manifests. Comparison is over the exact declared range
// strings: a pin next to a caret range is drift, and is either aligned or
// accepted through the signature baseline (dependency + sorted versions).
// The committed baseline records the two reviewed divergences; see
// scripts/workspace-version-drift-baseline.json:
//   fast-png — coding-agent/latex pin the exact version while
//     runtime/pss-image-codec-edge-qa use the caret range (same major).
//   @earendil-works/pi-tui — coding-agent depends on the current pi-tui
//     while the latex/mermaid extensions declare a wider peer floor.

export const DRIFT_BASELINE_PATH =
  "scripts/workspace-version-drift-baseline.json";
export const WORKSPACE_MANIFEST_PATH = "pnpm-workspace.yaml";

// The declared shared-dependency set (VAL-SEC-013): only these dependencies
// are compared across workspace manifests, never every dependency, so the
// check is deterministic and explainable. A dependency enters this list only
// when its version must stay aligned across every manifest that declares it;
// internal @minpeter/* packages are managed by the pnpm workspace protocol
// and stay out of the set.
export const SHARED_DEPENDENCIES = [
  "@ai-sdk/anthropic",
  "@ai-sdk/gateway",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/provider",
  "@ai-sdk/provider-utils",
  "@earendil-works/pi-tui",
  "ai",
  "fast-png",
  "zod",
];

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
];

// Workspace members come from the pnpm-workspace.yaml globs plus the root
// manifest; only the "<dir>/*" and literal forms this repository uses are
// expanded.
function workspaceDirs(root) {
  const globs =
    parseYaml(readFileSync(join(root, WORKSPACE_MANIFEST_PATH), "utf8"))
      ?.packages ?? [];
  const dirs = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = join(root, glob.slice(0, -2));
      if (!existsSync(parent)) {
        continue;
      }
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          dirs.push(join(parent, entry.name));
        }
      }
    } else {
      dirs.push(join(root, glob));
    }
  }
  return [root, ...dirs.sort()];
}

function recordDeclaredVersions(found, manifest, label) {
  for (const field of DEPENDENCY_FIELDS) {
    for (const dependency of SHARED_DEPENDENCIES) {
      const version = manifest?.[field]?.[dependency];
      if (typeof version !== "string") {
        continue;
      }
      if (!found.has(dependency)) {
        found.set(dependency, new Map());
      }
      const byVersion = found.get(dependency);
      if (!byVersion.has(version)) {
        byVersion.set(version, []);
      }
      byVersion.get(version).push(label);
    }
  }
}

// dependency -> version -> manifest paths (the root manifest labels ".").
function collectVersions(root) {
  const found = new Map();
  for (const dir of workspaceDirs(root)) {
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const label = dir === root ? "." : relative(root, dir);
    recordDeclaredVersions(found, manifest, label);
  }
  return found;
}

export function findDivergences(root) {
  const found = collectVersions(root);
  const divergences = [];
  for (const dependency of SHARED_DEPENDENCIES) {
    const byVersion = found.get(dependency);
    if (!byVersion || byVersion.size < 2) {
      continue;
    }
    const versions = [...byVersion.keys()].sort();
    divergences.push({
      dependency,
      versions,
      packages: versions.map((version) => ({
        version,
        packages: byVersion.get(version).sort(),
      })),
      signature: `${dependency}: ${versions.join(" ")}`,
    });
  }
  return divergences;
}

const SIGNATURE_PATTERN = /^(\S+): (\S+(?: \S+)+)$/;

export function baselineProblems(baseline) {
  if (baseline?.version !== 1 || !Array.isArray(baseline?.signatures)) {
    return ["baseline must be { version: 1, signatures: string[] }"];
  }
  const problems = [];
  const seen = new Set();
  const sorted = [...baseline.signatures].sort();
  baseline.signatures.forEach((signature, index) => {
    const match =
      typeof signature === "string" ? SIGNATURE_PATTERN.exec(signature) : null;
    if (!match) {
      problems.push(
        `signature[${index}] must be "<dependency>: <version> <version>" with sorted versions`
      );
      return;
    }
    const versions = match[2].split(" ");
    if (versions.some((v, i) => i > 0 && versions[i - 1] >= v)) {
      problems.push(
        `signature[${index}] versions are not sorted: ${signature}`
      );
    }
    if (seen.has(signature)) {
      problems.push(`duplicate baseline signature: ${signature}`);
    }
    seen.add(signature);
    if (signature !== sorted[index]) {
      problems.push("baseline signatures are not sorted");
    }
  });
  return problems;
}

export function diffDrift(divergences, baselineSignatures) {
  const accepted = new Set(baselineSignatures);
  const current = new Set(divergences.map((d) => d.signature));
  return {
    unbaselined: divergences.filter((d) => !accepted.has(d.signature)),
    stale: baselineSignatures.filter((s) => !current.has(s)),
  };
}

export function mismatchLine({ dependency, packages }) {
  const parts = packages.map(
    ({ version, packages: paths }) => `${version} [${paths.join(", ")}]`
  );
  return `MISMATCH ${dependency}: ${parts.join(" vs ")}`;
}
