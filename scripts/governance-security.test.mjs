import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  claimHits,
  credentialHits,
  hasDisclosureRule,
  hasHeading,
  hasReportingPath,
  hasScopeSection,
  LINKING_DOCS,
  linksToSecurity,
  missingPublishedPackages,
  missingRequestedDetails,
  PUBLISHED_PACKAGES,
  personalContactHits,
  readSecurity,
  referencedPackages,
  SECURITY_PATH,
  securityLinkResolves,
  unresolvedPackages,
  workspacePackageNames,
} from "./governance-security.mjs";

function security() {
  return readSecurity();
}

function tracked(path) {
  return spawnSync("git", ["ls-files", "--error-unmatch", path], {
    encoding: "utf8",
  });
}

describe("governance: SECURITY.md exists and is tracked (VAL-GOV-024)", () => {
  it("is git-tracked, non-empty, and has a markdown heading", () => {
    const status = tracked(SECURITY_PATH);
    expect(status.status, status.stderr).toBe(0);
    const text = security();
    expect(text.trim().length).toBeGreaterThan(0);
    expect(hasHeading(text)).toBe(true);
  });
});

describe("governance: SECURITY.md is linked from README and CONTRIBUTING (VAL-GOV-025)", () => {
  it("each linking doc references SECURITY.md and the target resolves", () => {
    expect(securityLinkResolves()).toBe(true);
    for (const doc of LINKING_DOCS) {
      const text = readFileSync(doc, "utf8");
      expect(linksToSecurity(text), `${doc} must link SECURITY.md`).toBe(true);
    }
  });

  it("a doc without a SECURITY.md link fails the link check", () => {
    expect(linksToSecurity("See the security policy for details.")).toBe(false);
    expect(linksToSecurity("[policy](SECURITY.md)")).toBe(true);
    expect(linksToSecurity("[policy](./SECURITY.md#reporting)")).toBe(true);
  });

  it("a broken (missing) target fails resolution", () => {
    expect(securityLinkResolves("scripts")).toBe(false);
  });
});

describe("governance: SECURITY.md documents a concrete reporting path (VAL-GOV-026)", () => {
  it("names GitHub private vulnerability reporting and the Report button", () => {
    expect(hasReportingPath(security())).toBe(true);
  });

  it("requires private disclosure until a fix ships", () => {
    expect(hasDisclosureRule(security())).toBe(true);
  });

  it("asks for repro, affected version, and impact", () => {
    expect(missingRequestedDetails(security())).toEqual([]);
  });

  it("contains no personal contact identities or credentials", () => {
    const text = security();
    expect(personalContactHits(text)).toEqual([]);
    expect(credentialHits(text)).toEqual([]);
  });

  it("flags an injected email address or credential literal", () => {
    expect(
      personalContactHits("Email security@example.com to report.")
    ).not.toEqual([]);
    // Build the credential-shaped fixture at runtime so no literal
    // token-shaped string is committed to source.
    expect(credentialHits(`leaked: ghp_${"A".repeat(30)}`)).not.toEqual([]);
  });

  it("fails the reporting path when the private-reporting instruction is absent", () => {
    expect(hasReportingPath("Email us to report a vulnerability.")).toBe(false);
    expect(hasDisclosureRule("Post your findings publicly right away.")).toBe(
      false
    );
  });
});

describe("governance: SECURITY.md declares a supported scope (VAL-GOV-027)", () => {
  it("has a scope/versions section", () => {
    expect(hasScopeSection(security())).toBe(true);
  });

  it("names both published packages and all named packages resolve", () => {
    const text = security();
    expect(missingPublishedPackages(text)).toEqual([]);
    expect(unresolvedPackages(text)).toEqual([]);
  });

  it("resolves scope across packages/* AND apps/* names", () => {
    const names = workspacePackageNames();
    // @minpeter/pss-coding-agent lives under apps/, not packages/.
    expect(names.has("@minpeter/pss-coding-agent")).toBe(true);
    expect(names.has("@minpeter/pss-runtime")).toBe(true);
    for (const pkg of PUBLISHED_PACKAGES) {
      expect(names.has(pkg), `${pkg} missing from workspace`).toBe(true);
    }
  });

  it("fails when scope names a package absent from the workspace", () => {
    const bogus = "Scope: `@minpeter/pss-does-not-exist`.";
    expect(unresolvedPackages(bogus)).toContain("@minpeter/pss-does-not-exist");
    expect(referencedPackages(bogus)).toContain("@minpeter/pss-does-not-exist");
  });
});

describe("governance: SECURITY.md makes no fabricated guarantees (VAL-GOV-028)", () => {
  it("the shipped file has zero completion-claim matches", () => {
    expect(claimHits(security())).toEqual([]);
  });

  it("allows deferral/negated wording", () => {
    expect(
      claimHits("There is no bug bounty and no response-time SLA.")
    ).toEqual([]);
    expect(
      claimHits("No externally hosted scanning service is guaranteed.")
    ).toEqual([]);
  });

  it("fails on an added completion claim", () => {
    expect(
      claimHits("We guarantee a 24-hour bounty response for every report.")
    ).not.toEqual([]);
    expect(claimHits("Our SLA is a fix within 48 hours.")).not.toEqual([]);
  });
});
