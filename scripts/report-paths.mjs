// Canonical registry of analysis-tool report paths and output caps
// (VAL-SEC-008/009). Every analysis tool — Knip, jscpd, workspace drift,
// bundle budget, test timing, flaky detection — declares its report path and
// its maximum entry count here; tool wrappers import their constants from
// this module so the registry is the single source of truth.
//
// Rules every entry must satisfy (enforced by scripts/report-hygiene.test.mjs):
//   id    kebab-case tool identifier, unique
//   path  report destination under an ignored root (report/, .omo/, .senpi/);
//         never a tracked path — reports are produced, never committed
//   cap   maximum report entries (a positive integer): a noisy run truncates
//         at this many entries and notes the truncation, so a report can
//         never exhaust CI storage or mask findings behind volume
//   ci    "local"    — report mode runs on demand locally; CI runs the gate
//         "artifact" — CI produces the report and uploads it as a bounded
//                      upload-artifact step (explicit retention-days), never
//                      committing it
//
// Cap rationale per tool (documented maxima):
//   knip / jscpd   500 finding signatures — the pre-existing
//                  REPORT_ENTRY_CAP shared by both wrappers
//   drift          200 mismatch entries — bounded by the declared
//                  shared-dependency set times workspace package count
//   bundle-budget  100 artifact rows — one per measured dist/ artifact
//   test-timing    10000 per-test duration entries — covers the full suite
//                  with headroom
//   flaky          1000 flaky-test entries across the bounded repetition
//                  window

export const REPORT_TOOLS = [
  { id: "knip", path: "report/knip-unused.json", cap: 500, ci: "local" },
  { id: "jscpd", path: "report/jscpd-duplicates.json", cap: 500, ci: "local" },
  { id: "drift", path: "report/workspace-drift.json", cap: 200, ci: "local" },
  {
    id: "bundle-budget",
    path: "report/bundle-size.json",
    cap: 100,
    ci: "local",
  },
  {
    id: "test-timing",
    path: "report/test-timing.json",
    cap: 10_000,
    ci: "artifact",
  },
  { id: "flaky", path: "report/flaky-tests.json", cap: 1000, ci: "artifact" },
];

// Ignored roots a report path may live under (VAL-SEC-008).
export const REPORT_ROOTS = ["report/", ".omo/", ".senpi/"];

// Root variants probed with `git check-ignore`: the bare `report` name, the
// `report/` directory, and the .omo/.senpi roots must all be covered by a
// .gitignore pattern.
export const ROOT_PROBES = [
  "report",
  "report/.probe",
  ".omo/.probe",
  ".senpi/.probe",
];

export function reportTool(id) {
  return REPORT_TOOLS.find((tool) => tool.id === id);
}

const KEBAB_ID = /^[a-z0-9-]+$/;
const CI_MODES = new Set(["local", "artifact"]);

// Registry shape validation: pure over the declared entries.
export function registryProblems(tools = REPORT_TOOLS) {
  const problems = [];
  const ids = new Set();
  const paths = new Set();
  for (const tool of tools) {
    const label = `report tool ${JSON.stringify(tool?.id)}`;
    if (typeof tool?.id !== "string" || !KEBAB_ID.test(tool.id)) {
      problems.push(`${label} needs a kebab-case id`);
    } else if (ids.has(tool.id)) {
      problems.push(`duplicate report tool id "${tool.id}"`);
    }
    ids.add(tool?.id);
    if (
      typeof tool?.path !== "string" ||
      !REPORT_ROOTS.some((root) => tool.path.startsWith(root))
    ) {
      problems.push(
        `${label} path must live under one of ${REPORT_ROOTS.join(", ")}`
      );
    } else if (paths.has(tool.path)) {
      problems.push(`duplicate report path "${tool.path}"`);
    }
    paths.add(tool?.path);
    if (
      typeof tool?.cap !== "number" ||
      !Number.isInteger(tool.cap) ||
      tool.cap < 1
    ) {
      problems.push(`${label} cap must be a positive integer entry count`);
    }
    if (!CI_MODES.has(tool?.ci)) {
      problems.push(`${label} ci mode must be one of: local, artifact`);
    }
  }
  return problems;
}
