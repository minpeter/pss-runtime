import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatedFreerouterBaseUrl } from "./freerouter-url.mjs";

const HTTPS_REQUIRED_PATTERN = /must use HTTPS/u;
const CREDENTIALS_FORBIDDEN_PATTERN = /must not contain credentials/u;
const API_ROOT_REQUIRED_PATTERN = /must end at the \/v1 API root/u;

describe("validatedFreerouterBaseUrl", () => {
  it("accepts and canonicalizes an HTTPS /v1 API root", () => {
    assert.equal(
      validatedFreerouterBaseUrl("https://freerouter.example/v1/"),
      "https://freerouter.example/v1"
    );
  });

  it("rejects remote plaintext HTTP before a bearer credential can be sent", () => {
    assert.throws(
      () => validatedFreerouterBaseUrl("http://freerouter.example/v1"),
      HTTPS_REQUIRED_PATTERN
    );
  });

  it("rejects credentials, query data, and fragments", () => {
    for (const value of [
      "https://user:password@freerouter.example/v1",
      "https://freerouter.example/v1?route=other",
      "https://freerouter.example/v1#other",
    ]) {
      assert.throws(
        () => validatedFreerouterBaseUrl(value),
        CREDENTIALS_FORBIDDEN_PATTERN
      );
    }
  });

  it("rejects URLs outside the exact /v1 API root", () => {
    for (const value of [
      "https://freerouter.example/",
      "https://freerouter.example/v1/chat/completions",
      "https://freerouter.example/api/v1",
    ]) {
      assert.throws(
        () => validatedFreerouterBaseUrl(value),
        API_ROOT_REQUIRED_PATTERN
      );
    }
  });
});
