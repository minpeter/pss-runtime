import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_DOC_PATH,
  matchDocumentedPath,
  OBSERVATIONS_PATH,
  parseContractDocument,
  parseObservations,
} from "./worker-api-contract.mjs";
import {
  authMatrixProblems,
  diffContract,
  diffLiveRecords,
} from "./worker-api-contract-diff.mjs";

const CLI = "scripts/check-worker-api-contract.mjs";
const TMP_DIR = ".omo/tmp/worker-api-contract";

const OPENAPI_MAJOR_PATTERN = /^3\./u;
const OPENAPI_VERSION_ERROR = /OpenAPI 3/u;
const INFO_ERROR = /info/u;
const HEALTH_503_UNREPRODUCED =
  /documented-but-unreproduced: GET \/healthz status 503/u;
const BOGUS_PROBE_OMITTED = /observed-but-omitted: bogus-probe/u;
const UNREPRODUCED_PROBLEM = /documented-but-unreproduced/u;
const HEALTH_SECURITY_PROBLEM = /\/healthz.*must not declare/iu;
const DEV_EXCEPTION_PROBLEM = /development exception/iu;
const SSE_BEARER_PROBE_PROBLEM =
  /\/session\/events lacks an observed token\/bearer-missing probe/u;
const CATCH_ALL_SCHEME_PROBLEM = /catch-all must declare only/iu;
const HEALTH_POST_NOT_EXERCISED = /health-post was not exercised/u;
const HEALTH_GET_201_PROBLEM = /health-get answered 201/u;
const UNCOMMITTED_LIVE_PROBLEM = /uncommitted-live-probe/u;
const HEALTHZ_SECURITY_MUTATION =
  /( {6}summary: Unauthenticated liveness probe[\s\S]*?) {6}security: \[\]/u;

function docText() {
  return readFileSync(CONTRACT_DOC_PATH, "utf8");
}

function committed() {
  return parseObservations(readFileSync(OBSERVATIONS_PATH, "utf8"));
}

function paths() {
  return parseContractDocument(docText()).paths;
}

describe("worker api contract: the committed document parses (VAL-WORKER-029)", () => {
  it("is valid YAML with an OpenAPI 3 version, info, and the expected paths", () => {
    const { raw, paths: entries } = parseContractDocument(docText());
    expect(raw.openapi).toMatch(OPENAPI_MAJOR_PATTERN);
    expect(raw.info.title).toBeTruthy();
    expect(entries.map((entry) => entry.docPath)).toEqual([
      "/healthz",
      "/session/events",
      "/trpc",
      "/trpc/session.replayEvents",
      "/trpc/session.submitTurn",
      "/trpc/tui.turn",
      "/trpc/{procedure}",
      "/{webhookPath}",
    ]);
  });

  it("rejects a document that is not OpenAPI 3", () => {
    expect(() => parseContractDocument("info: {}")).toThrow(
      OPENAPI_VERSION_ERROR
    );
    expect(() => parseContractDocument("openapi: 3.0.3\ninfo: {}")).toThrow(
      INFO_ERROR
    );
  });
});

describe("worker api contract: schema constraints match Worker validators", () => {
  it("declares nonblank channel IDs, turn text, and canonical SSE cursors", () => {
    const raw = parseContractDocument(docText()).raw;
    const schemas = raw.components.schemas;
    expect(schemas.ChannelAddress.properties.id).toMatchObject({
      minLength: 1,
      pattern: ".*\\S.*",
    });
    expect(
      raw.paths["/session/events"].get.parameters.find(
        (parameter) => parameter.name === "channel"
      ).schema.minLength
    ).toBe(1);
    expect(
      raw.paths["/session/events"].get.parameters.find(
        (parameter) => parameter.name === "after"
      ).schema
    ).toMatchObject({
      minLength: 1,
      pattern: "^(0|[1-9]\\d*)$",
    });
    expect(
      raw.paths["/trpc/session.submitTurn"].post.requestBody.content[
        "application/json"
      ].schema.properties.text
    ).toMatchObject({
      minLength: 1,
      pattern: ".*\\S.*",
    });
    expect(
      raw.paths["/trpc/tui.turn"].post.requestBody.content["application/json"]
        .schema.properties.text
    ).toMatchObject({
      minLength: 1,
      pattern: ".*\\S.*",
    });
  });

  it("includes BAD_GATEWAY in the documented tRPC error code enum", () => {
    const raw = parseContractDocument(docText()).raw;
    expect(
      raw.components.schemas.TrpcErrorEnvelope.properties.error.properties.data
        .properties.code.enum
    ).toContain("BAD_GATEWAY");
  });
});

describe("worker api contract: doc matches committed observations (VAL-WORKER-029)", () => {
  it("reports zero mismatches for the committed pair", () => {
    expect(diffContract(paths(), committed())).toEqual([]);
    expect(authMatrixProblems(paths(), committed(), docText())).toEqual([]);
  });

  it("the CLI gate exits 0 for the committed pair", () => {
    const run = spawnSync("node", [CLI, "--check"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("zero mismatches");
  });

  it("fails when a documented status loses its probe (documented-but-unreproduced)", () => {
    const records = committed().filter(
      (record) => record.id !== "health-unavailable"
    );
    const problems = diffContract(paths(), records);
    expect(problems.join("\n")).toMatch(HEALTH_503_UNREPRODUCED);
  });

  it("fails when a probe is not documented (observed-but-omitted)", () => {
    const records = [
      ...committed(),
      {
        auth: "none",
        env: "any",
        id: "bogus-probe",
        method: "GET",
        path: "/definitely-not-a-real-route-but-undocumented-behavior",
        status: 200,
        via: ["unit"],
      },
    ];
    // Route the bogus probe at the catch-all with an undocumented status.
    const problems = diffContract(paths(), [
      ...records.slice(0, -1),
      { ...records.at(-1), path: "/trpc", status: 418 },
    ]);
    expect(problems.join("\n")).toMatch(BOGUS_PROBE_OMITTED);
  });

  it("fails when the CLI is pointed at a mutated observations file", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const mutated = {
      records: committed().filter(
        (record) => record.id !== "sse-get-unauthorized"
      ),
    };
    const fixture = `${TMP_DIR}/mutated-observations.json`;
    writeFileSync(fixture, JSON.stringify(mutated));
    const run = spawnSync("node", [CLI, "--check", "--observations", fixture], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(UNREPRODUCED_PROBLEM);
  });
});

describe("worker api contract: path matching", () => {
  it("matches concrete paths, aliases, the procedure template, and the catch-all", () => {
    const entries = paths();
    expect(matchDocumentedPath(entries, "/healthz")?.docPath).toBe("/healthz");
    expect(matchDocumentedPath(entries, "/healthz/")?.docPath).toBe("/healthz");
    expect(
      matchDocumentedPath(entries, "/trpc/session.replayEvents")?.docPath
    ).toBe("/trpc/session.replayEvents");
    expect(matchDocumentedPath(entries, "/trpc/does-not-exist")?.docPath).toBe(
      "/trpc/{procedure}"
    );
    expect(matchDocumentedPath(entries, "/trpc")?.docPath).toBe("/trpc");
    expect(matchDocumentedPath(entries, "/")?.docPath).toBe("/{webhookPath}");
    expect(matchDocumentedPath(entries, "/healthz/foo")?.docPath).toBe(
      "/{webhookPath}"
    );
    expect(
      matchDocumentedPath(entries, "/session/events/replay")?.docPath
    ).toBe("/{webhookPath}");
  });
});

describe("worker api contract: auth matrix truthfulness (VAL-WORKER-030)", () => {
  it("fails when /healthz claims a security scheme", () => {
    const mutated = docText().replace(
      HEALTHZ_SECURITY_MUTATION,
      "$1      security:\n        - TuiBearerToken: []"
    );
    expect(mutated).not.toBe(docText());
    const problems = authMatrixProblems(
      parseContractDocument(mutated).paths,
      committed(),
      mutated
    );
    expect(problems.join("\n")).toMatch(HEALTH_SECURITY_PROBLEM);
  });

  it("fails when the development exception is not recorded", () => {
    const mutated = docText().replaceAll("not configured", "omitted phrase");
    expect(mutated).not.toBe(docText());
    const problems = authMatrixProblems(paths(), committed(), mutated);
    expect(problems.join("\n")).toMatch(DEV_EXCEPTION_PROBLEM);
  });

  it("fails when the bearer-missing 401 probe is absent for a protected path", () => {
    const records = committed().filter(
      (record) => record.id !== "sse-get-unauthorized"
    );
    const problems = authMatrixProblems(paths(), records, docText());
    expect(problems.join("\n")).toMatch(SSE_BEARER_PROBE_PROBLEM);
  });

  it("fails when the catch-all loses its webhook-secret scheme", () => {
    const mutated = docText().replaceAll(
      "- TelegramWebhookSecretToken: []",
      "- TuiBearerToken: []"
    );
    const problems = authMatrixProblems(
      parseContractDocument(mutated).paths,
      committed(),
      mutated
    );
    expect(problems.join("\n")).toMatch(CATCH_ALL_SCHEME_PROBLEM);
  });
});

describe("worker api contract: live-probe comparison", () => {
  it("accepts a live records file reproducing every live-marked record", () => {
    const live = committed()
      .filter((record) => record.via.includes("live"))
      .map((record) => ({ ...record }));
    expect(diffLiveRecords(paths(), committed(), live)).toEqual([]);
  });

  it("fails when a live-marked record is not exercised", () => {
    const live = committed()
      .filter((record) => record.via.includes("live"))
      .filter((record) => record.id !== "health-post");
    const problems = diffLiveRecords(paths(), committed(), live);
    expect(problems.join("\n")).toMatch(HEALTH_POST_NOT_EXERCISED);
  });

  it("fails when a live probe answers a different status", () => {
    const live = committed()
      .filter((record) => record.via.includes("live"))
      .map((record) =>
        record.id === "health-get" ? { ...record, status: 201 } : record
      );
    const problems = diffLiveRecords(paths(), committed(), live);
    expect(problems.join("\n")).toMatch(HEALTH_GET_201_PROBLEM);
  });

  it("fails when a live probe is not in the committed records", () => {
    const live = [
      ...committed().filter((record) => record.via.includes("live")),
      {
        auth: "none",
        env: "any",
        id: "uncommitted-live-probe",
        method: "GET",
        path: "/healthz",
        status: 200,
        via: ["live"],
      },
    ];
    const problems = diffLiveRecords(paths(), committed(), live);
    expect(problems.join("\n")).toMatch(UNCOMMITTED_LIVE_PROBLEM);
  });
});
