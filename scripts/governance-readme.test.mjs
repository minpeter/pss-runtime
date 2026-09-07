import { describe, expect, it } from "vitest";
import {
  APP_README_FILE,
  appReadmeProblems,
  CORE_GOVERNANCE_DOCS,
  deferralNoteLines,
  disruptiveActionHits,
  externalControlClaimHits,
  governanceDocs,
  missingGateScripts,
  quickStartProblems,
  README_FILE,
  RUNBOOKS_DIR,
  readDoc,
  relativeLinks,
  SKILLS_DIR,
  unknownDocPnpmTokens,
  unknownTokensIn,
  unresolvedDocLinks,
  unresolvedLinksIn,
  unresolvedWorkerAgentRefs,
  workerAgentRefs,
} from "./governance-readme.mjs";

const readme = readDoc(README_FILE);

describe("governance: README quick start stays API-correct (VAL-GOV-047)", () => {
  it("keeps the public factory/thread/turn tokens and no legacy strings", () => {
    expect(quickStartProblems(readme)).toEqual([]);
  });

  it("fails on a reintroduced legacy API string or a dropped token", () => {
    expect(quickStartProblems(`${readme}\nconst a = new Agent({});`)).toEqual([
      "forbidden legacy API string: new Agent({",
    ]);
    expect(
      quickStartProblems(readme.replace('agent.thread("default")', "agent.x()"))
    ).toEqual(['missing quick-start token: agent.thread("default")']);
  });
});

describe("governance: README states operational boundaries honestly (VAL-GOV-048)", () => {
  it("carries an explicit deferral note for external-only controls", () => {
    expect(deferralNoteLines(readme).length).toBeGreaterThan(0);
  });

  it("makes no completion-style external-control claim", () => {
    expect(externalControlClaimHits(readme)).toEqual([]);
  });

  it("flags completion claims and allows deferral wording", () => {
    expect(
      externalControlClaimHits("Branch protection is enabled and verified.")
    ).not.toEqual([]);
    expect(
      externalControlClaimHits("Sentry error tracking is active.")
    ).not.toEqual([]);
    expect(
      externalControlClaimHits("PagerDuty alerting is deferred and external.")
    ).toEqual([]);
    expect(
      externalControlClaimHits("Production monitoring cannot be verified here.")
    ).toEqual([]);
  });
});

describe("governance: app README contracts are preserved (VAL-GOV-049)", () => {
  it("keeps the coding-agent thread env docs without legacy sessions", () => {
    expect(appReadmeProblems(readDoc(APP_README_FILE))).toEqual([]);
  });

  it("resolves every runbook/skill citation of docs/worker-agent.md", () => {
    expect(unresolvedWorkerAgentRefs()).toEqual([]);
    // The citation must actually exist somewhere in the governance docs.
    const cited = governanceDocs().some(
      (doc) => workerAgentRefs(readDoc(doc)).length > 0
    );
    expect(cited).toBe(true);
  });

  it("fails when the app README drops a knob or cites a missing doc", () => {
    expect(appReadmeProblems("no knobs here")).toEqual([
      "missing env knob documentation: PSS_THREAD_DIR",
      "missing env knob documentation: PSS_THREAD_KEY",
    ]);
    expect(
      appReadmeProblems(
        "PSS_THREAD_DIR PSS_THREAD_KEY store at ~/.pss/sessions"
      )
    ).toEqual(["legacy ~/.pss/sessions reference"]);
    expect(workerAgentRefs("[otel](../worker-agent.md)")).toEqual([
      "../worker-agent.md",
    ]);
    expect(
      unresolvedLinksIn("docs/runbooks/x.md", "[w](../nope-worker-agent.md)")
    ).toEqual(["docs/runbooks/x.md -> ../nope-worker-agent.md"]);
  });
});

describe("governance: README documents no disruptive local actions (VAL-GOV-050)", () => {
  it("has no instruction-style publish/deploy/production step", () => {
    expect(disruptiveActionHits(readme)).toEqual([]);
  });

  it("flags instruction-style hits and allows deferral wording", () => {
    expect(disruptiveActionHits("Run npm publish to release.")).not.toEqual([]);
    expect(
      disruptiveActionHits("Deploy with wrangler deploy now.")
    ).not.toEqual([]);
    expect(
      disruptiveActionHits(
        "Production deployment is deferred and external; never run it locally."
      )
    ).toEqual([]);
  });
});

describe("governance: relative links resolve (VAL-GOV-051)", () => {
  it("scans the core governance docs plus runbooks and skills", () => {
    const docs = governanceDocs();
    for (const doc of CORE_GOVERNANCE_DOCS) {
      expect(docs).toContain(doc);
    }
    expect(docs).toContain(`${RUNBOOKS_DIR}/README.md`);
    expect(docs.some((doc) => doc.startsWith(`${SKILLS_DIR}/`))).toBe(true);
  });

  it("resolves every repo-relative markdown link", () => {
    expect(unresolvedDocLinks()).toEqual([]);
  });

  it("fails on a dangling relative link and ignores external URLs", () => {
    expect(
      unresolvedLinksIn("README.md", "[x](missing-file.md) [ok](SECURITY.md)")
    ).toEqual(["README.md -> missing-file.md"]);
    expect(
      relativeLinks("[a](https://example.com) [b](#anchor) [c](mailto:x@y.z)")
    ).toEqual([]);
  });
});

describe("governance: documented pnpm tokens are real root scripts (VAL-GOV-052)", () => {
  it("keeps the milestone gate commands in root package.json", () => {
    expect(missingGateScripts()).toEqual([]);
  });

  it("documents only pnpm tokens that exist as root scripts", () => {
    expect(unknownDocPnpmTokens()).toEqual([]);
  });

  it("fails on a documented nonexistent script token", () => {
    const scripts = new Set(["lint", "test"]);
    expect(
      unknownTokensIn("run pnpm lint then pnpm deploy:prod", scripts)
    ).toEqual(["deploy:prod"]);
    // pnpm built-ins and --filter package targets are not root-script claims.
    expect(unknownTokensIn("pnpm install --frozen-lockfile", scripts)).toEqual(
      []
    );
    expect(
      unknownTokensIn(
        "pnpm --filter @minpeter/pss-worker-agent dev:worker",
        scripts
      )
    ).toEqual([]);
  });
});
