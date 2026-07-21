import { describe, expect, it } from "vitest";
import {
  compareVersions,
  extractUpdateChannel,
  isValidVersion,
} from "./update-version";

describe("extractUpdateChannel", () => {
  it("tracks the latest channel for a stable release version", () => {
    expect(extractUpdateChannel("0.0.13")).toBe("latest");
  });

  it("tracks the next channel for a next prerelease version", () => {
    expect(extractUpdateChannel("0.0.14-next.2")).toBe("next");
  });

  it("falls back to the latest channel for an unrecognized prerelease", () => {
    expect(extractUpdateChannel("1.0.0-beta.1")).toBe("latest");
  });
});

describe("isValidVersion", () => {
  it("accepts release and prerelease versions", () => {
    expect(isValidVersion("0.0.13")).toBe(true);
    expect(isValidVersion("0.0.14-next.2")).toBe(true);
    expect(isValidVersion("1.2.3-rc.10")).toBe(true);
  });

  it("accepts alphanumeric prerelease identifiers", () => {
    expect(isValidVersion("1.0.0-alpha.1")).toBe(true);
    expect(isValidVersion("1.0.0-x-y-z.-")).toBe(true);
  });

  it("rejects malformed versions", () => {
    expect(isValidVersion("")).toBe(false);
    expect(isValidVersion("0.0")).toBe(false);
    expect(isValidVersion("v0.0.13")).toBe(false);
    expect(isValidVersion("0.0.13-")).toBe(false);
    expect(isValidVersion("0.0.x")).toBe(false);
  });

  it("rejects numeric identifiers with leading zeroes", () => {
    expect(isValidVersion("01.0.0")).toBe(false);
    expect(isValidVersion("1.01.0")).toBe(false);
    expect(isValidVersion("1.0.0-01")).toBe(false);
    expect(isValidVersion("1.0.0-next.01")).toBe(false);
    expect(isValidVersion("1.0.0-0")).toBe(true);
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch numerically", () => {
    expect(compareVersions("0.0.13", "0.0.13")).toBe(0);
    expect(compareVersions("0.0.14", "0.0.13")).toBeGreaterThan(0);
    expect(compareVersions("0.0.9", "0.0.10")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "0.0.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("orders a release after its own prereleases", () => {
    expect(compareVersions("0.0.14", "0.0.14-next.2")).toBeGreaterThan(0);
    expect(compareVersions("0.0.14-next.1", "0.0.14")).toBeLessThan(0);
  });

  it("orders prerelease identifiers numerically", () => {
    expect(compareVersions("0.0.14-next.2", "0.0.14-next.1")).toBeGreaterThan(
      0
    );
    expect(compareVersions("0.0.14-next.2", "0.0.14-next.10")).toBeLessThan(0);
  });
});
