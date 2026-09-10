import { describe, expect, it } from "vitest";
import {
  activationClaimHits,
  deferralLinkProblems,
  finalActivationHits,
  followUpBoundaryProblems,
  gitleaksDeferralProblems,
  linkSurfaces,
  surfaceLinkProblem,
} from "./final-deferred.mjs";
import { readDoc } from "./governance-deferred.mjs";
import {
  deferredClaimHits,
  repoWideClaimHits,
} from "./governance-deferred-scan.mjs";
import { DEFERRED_DOC } from "./governance-readme.mjs";

const doc = readDoc(DEFERRED_DOC);

const FOLLOW_UP_LINE = /^- Follow-up boundary:.*$/m;
const FIRST_BOUNDARY_BLOCK =
  /- Follow-up boundary:[\s\S]*?repository-local check\./;
const PENDING_ACTIVATION =
  /stay pending until\n {2}the next push activates them in CI/i;

describe("final docs: deferred items carry follow-up boundaries (VAL-CROSS-016)", () => {
  it("gives every deferred item an explicit follow-up boundary that references the single list", () => {
    expect(followUpBoundaryProblems(doc)).toEqual([]);
  });

  it("fails when an item loses its follow-up boundary line", () => {
    const stripped = doc.replace(FOLLOW_UP_LINE, "");
    expect(followUpBoundaryProblems(stripped)).toContain(
      "branch-protection-enforcement: missing follow-up boundary line"
    );
  });

  it("fails when a follow-up boundary stops referencing the single list", () => {
    const moved = doc.replace(
      "`docs/deferred-controls.md`",
      "`docs/elsewhere.md`"
    );
    expect(
      followUpBoundaryProblems(moved).some((p) =>
        p.includes("does not reference docs/deferred-controls.md")
      )
    ).toBe(true);
  });

  it("fails when a follow-up boundary loses deferral wording", () => {
    const claimed = doc.replace(
      FIRST_BOUNDARY_BLOCK,
      "- Follow-up boundary: complete this item; see `docs/deferred-controls.md`."
    );
    expect(
      followUpBoundaryProblems(claimed).some((p) =>
        p.includes("lacks deferral wording")
      )
    ).toBe(true);
  });
});

describe("final docs: every boundary surface links the single deferred list", () => {
  it("links the list from the README, the label taxonomy, and every runbook", () => {
    expect(linkSurfaces()).toContain("README.md");
    expect(linkSurfaces()).toContain("docs/label-taxonomy.md");
    expect(linkSurfaces().length).toBeGreaterThanOrEqual(9);
    expect(deferralLinkProblems()).toEqual([]);
  });

  it("fails when a surface drops the link", () => {
    expect(
      surfaceLinkProblem("docs/runbooks/worker-health.md", "no links here")
    ).toContain("does not link the single deferred list");
    expect(
      surfaceLinkProblem("docs/runbooks/x.md", "[x](../deferred-controls.md)")
    ).toBeNull();
  });
});

describe("final docs: no completion claim passes the deferred-claim rule", () => {
  it("finds zero completion claims across the final documentation", () => {
    expect(repoWideClaimHits()).toEqual([]);
  });

  it("fails a completion claim and allows deferral wording", () => {
    expect(
      deferredClaimHits("Progressive rollout is configured for the Worker.")
    ).not.toEqual([]);
    expect(
      deferredClaimHits(
        "Progressive rollout is deferred and external; see the single list."
      )
    ).toEqual([]);
  });
});

describe("final docs: no security-workflow CI activation claims (VAL-CROSS-016)", () => {
  it("finds zero activation claims across docs and workflow labels", () => {
    expect(finalActivationHits()).toEqual([]);
  });

  it("flags activation claims and allows deferral wording", () => {
    expect(
      activationClaimHits("The gitleaks CI workflow is active.")
    ).not.toEqual([]);
    expect(
      activationClaimHits("The CodeQL workflow is enabled for this repo.")
    ).not.toEqual([]);
    expect(activationClaimHits("The gitleaks run passed in CI.")).not.toEqual(
      []
    );
    expect(
      activationClaimHits(
        "gitleaks activation stays external and pending until the next push."
      )
    ).toEqual([]);
  });
});

describe("final docs: gitleaks CI activation stays worded as pending until push", () => {
  it("keeps the pending-push note in the deferred list and the never-claim boundary in the runbook", () => {
    expect(gitleaksDeferralProblems(doc)).toEqual([]);
  });

  it("fails when the gitleaks activation wording loses its pending marker", () => {
    const activated = doc.replace(
      PENDING_ACTIVATION,
      "are running in CI today"
    );
    expect(gitleaksDeferralProblems(activated)).toContain(
      "native-secret-scanning: no gitleaks line carries pending/deferred activation wording"
    );
  });
});
