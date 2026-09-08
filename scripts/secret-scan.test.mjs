import { describe, expect, it } from "vitest";
import {
  allowlistHygieneProblems,
  SCAN_ALLOWLIST,
  textCredentialHits,
  trackedFiles,
  treeCredentialHits,
  unexpectedHitProblems,
} from "./secret-scan.mjs";

// Full tracked-tree credential scan (VAL-CROSS-015): no git-tracked file may
// contain secret-shaped content (tokens, keys, JWTs, bot tokens, raw env
// credential exports) outside a pinned allowlist of scanner-definition and
// negative-fixture files. The allowlist is exact: every entry must stay
// tracked and keep producing its pinned kinds, so it cannot rot silently.
// Credential-shaped fixture values are assembled at runtime so no scanner
// ever sees a full token literal in this file.

const FAKE_PROVIDER_KEY = ["sk", "Fixture0".repeat(4)].join("-");
const FAKE_EXPORT = `export FIXTURE_API_KEY=${"q".repeat(16)}`;

describe("tracked-tree secret scan (VAL-CROSS-015)", () => {
  it("finds no credential-shaped content outside the pinned allowlist", () => {
    const files = trackedFiles();
    const hits = treeCredentialHits(files);
    expect(unexpectedHitProblems(hits, SCAN_ALLOWLIST)).toEqual([]);
  });

  it("keeps every allowlist entry tracked and exercised", () => {
    const files = trackedFiles();
    const hits = treeCredentialHits(files);
    expect(allowlistHygieneProblems(hits, SCAN_ALLOWLIST, files)).toEqual([]);
  });

  it("flags a credential in an arbitrary tracked path", () => {
    const files = ["docs/new-runbook.md"];
    const reader = () => `token: ${FAKE_PROVIDER_KEY}\n`;
    const hits = treeCredentialHits(files, reader);
    expect(hits).toHaveLength(1);
    expect(unexpectedHitProblems(hits, SCAN_ALLOWLIST)).toHaveLength(1);
    expect(unexpectedHitProblems(hits, SCAN_ALLOWLIST)[0]).toContain(
      "docs/new-runbook.md"
    );
  });

  it("flags a new credential kind inside an allowlisted file", () => {
    const [allowlistedPath] = Object.keys(SCAN_ALLOWLIST);
    const files = [allowlistedPath];
    const reader = () => `${FAKE_EXPORT}\n`;
    const hits = treeCredentialHits(files, reader);
    expect(unexpectedHitProblems(hits, SCAN_ALLOWLIST)).toHaveLength(1);
  });

  it("allows the exact pinned kind inside an allowlisted file", () => {
    const path = "scripts/governance-invariants.test.mjs";
    const kinds = SCAN_ALLOWLIST[path];
    expect(kinds).toContain("provider API key");
    const files = [path];
    const reader = () => `token: ${FAKE_PROVIDER_KEY}\n`;
    const hits = treeCredentialHits(files, reader);
    expect(unexpectedHitProblems(hits, SCAN_ALLOWLIST)).toEqual([]);
  });

  it("skips binary content via the NUL guard", () => {
    const text = `prefix ${FAKE_PROVIDER_KEY} suffix`;
    expect(textCredentialHits(text)).toHaveLength(1);
    expect(textCredentialHits(`a\0${text}`)).toEqual([]);
  });
});
