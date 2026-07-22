import assert from "node:assert/strict";
import test from "node:test";
import { resolveNextVersion, resolveStartsPerMinute } from "../src/config.mjs";

test("next version defaults to the pinned reproducible canary", () => {
  assert.equal(resolveNextVersion(), "16.3.0-canary.89");
});

test("explicit next version overrides the pin", () => {
  assert.equal(resolveNextVersion("16.3.0-canary.90"), "16.3.0-canary.90");
  assert.equal(
    resolveNextVersion(undefined, "16.3.0-canary.91"),
    "16.3.0-canary.91"
  );
  assert.equal(
    resolveNextVersion("16.3.0-canary.90", "16.3.0-canary.91"),
    "16.3.0-canary.90"
  );
});

test("starts-per-minute falls back to a positive default", () => {
  assert.equal(resolveStartsPerMinute(undefined), 4);
  assert.equal(resolveStartsPerMinute("0"), 4);
  assert.equal(resolveStartsPerMinute("-3"), 4);
  assert.equal(resolveStartsPerMinute("abc"), 4);
  assert.equal(resolveStartsPerMinute("2.5"), 4);
  assert.equal(resolveStartsPerMinute("10"), 10);
});
