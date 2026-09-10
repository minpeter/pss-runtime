import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ZAP_WORKFLOW_PATH } from "./security-zap.mjs";

const workflow = parse(readFileSync(ZAP_WORKFLOW_PATH, "utf8"));
const job = workflow.jobs.baseline;
const validation = job.steps.find((step) => step.id === "validate-target");
const scan = job.steps.find((step) => step.uses?.startsWith("zaproxy/"));
const expr = (body) => ["$", "{{ ", body, " }}"].join("");
const SCAN_SENTINEL = "SCAN_INVOKED";

// Exercise the shipped bash/Python step. Only DNS is replaced: numeric hosts
// still use libc's actual numeric parser, without external DNS or sockets.
// The sentinel stands in for the action after successful preflight execution.
function validate(target, dns = null) {
  const dnsFixture = `import json, os, socket
_real_getaddrinfo = socket.getaddrinfo
_fixture = json.loads(os.environ["DNS_FIXTURE"])
def resolve(host, port, *, type):
    if _fixture is None:
        return _real_getaddrinfo(host, port, type=type, flags=socket.AI_NUMERICHOST)
    assert host == "staging.example.com", host
    assert port == 8443, port
    assert type == socket.SOCK_STREAM, type
    if _fixture == "error":
        raise socket.gaierror("fixture resolution failure")
    return [(socket.AF_INET6 if ":" in ip else socket.AF_INET,
             type, 6, "", (ip, port)) for ip in _fixture]
socket.getaddrinfo = resolve
`;
  const run = validation.run.replace("<<'PY'\n", `<<'PY'\n${dnsFixture}`);
  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-eo",
      "pipefail",
      "-c",
      `${run}\nprintf '${SCAN_SENTINEL}\\n'`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TARGET_URL: target,
        DNS_FIXTURE: JSON.stringify(dns),
      },
      timeout: 5000,
    }
  );
}

function expectRejected(target, dns = null) {
  const result = validate(target, dns);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("::error::");
  expect(result.stdout).not.toContain(SCAN_SENTINEL);
}

function expectAccepted(target, dns = null) {
  const result = validate(target, dns);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(SCAN_SENTINEL);
}

describe("zap target: mandatory bounded preflight before the action", () => {
  it("preserves manual dispatch, empty skip, and input-only scan targeting", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs["target-url"].default).toBe("");
    const skip = job.steps.find(
      (step) => step.if === expr("inputs.target-url == ''")
    );
    expect(skip).toBeDefined();
    expect(validation.if).toBe(expr("inputs.target-url != ''"));
    expect(scan.if).toBe(validation.if);
    expect(scan.with.target).toBe(expr("inputs.target-url"));
    const result = spawnSync("bash", ["-eo", "pipefail", "-c", skip.run], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "/dev/null" },
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it("does not interpolate input into shell and cannot ignore preflight failure", () => {
    expect(validation.shell).toBe("bash");
    expect(validation.env.TARGET_URL).toBe(expr("inputs.target-url"));
    expect(validation.run).not.toContain(expr("inputs.target-url"));
    expect(validation["timeout-minutes"]).toBe(1);
    expect(validation.run.split("\n")[0]).toBe("timeout 20s python3 - <<'PY'");
    expect(validation["continue-on-error"] ?? false).toBe(false);
    expect(job["continue-on-error"] ?? false).toBe(false);
    expect(job.steps.indexOf(validation)).toBeLessThan(job.steps.indexOf(scan));
  });
});

describe("zap target: reject local/private URLs before scanning", () => {
  it.each([
    "http://localhost:3000",
    "https://LOCALHOST./",
    "http://app.localhost/",
    "http://service.local/",
    "http://service.internal/",
    "http://127.0.0.1/",
    "http://127.255.255.254/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://10.0.0.1/",
    "https://172.16.0.1/",
    "http://172.31.255.254/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://100.64.0.1/",
    `http://${[0, 0, 0, 0].join(".")}/`,
    "http://224.0.0.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fe80::1%25eth0]/",
    "http://[fc00::1]/",
    "http://[fd12::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://[ff02::1]/",
  ])("rejects %s", (target) => {
    expectRejected(target);
  });

  it.each([
    "",
    "not-a-url",
    "ftp://8.8.8.8/",
    "https:///missing-host",
    "https://user:password@8.8.8.8/",
    "https://8.8.8.8:65536/",
    "https://8.8.8.8:0/",
    "https://8.8.8.8:invalid/",
    "https://[::1",
    "https://%6cocalhost/",
    "https://8.8.8.8\\@127.0.0.1/",
    " https://8.8.8.8/",
    "https://8.8.8.8/\n",
    "https://8.8.8.8/$(exit 0)",
  ])("rejects malformed or ambiguous input %j", (target) => {
    expectRejected(target);
  });

  it.each(
    [
      ["127.0.0.1"],
      ["10.1.2.3"],
      ["172.16.1.2"],
      ["192.168.1.2"],
      ["169.254.1.2"],
      ["::1"],
      ["fe80::1"],
      ["fd00::1"],
      ["8.8.8.8", "10.1.2.3"],
      ["10.1.2.3", "8.8.8.8"],
      ["8.8.8.8", "fe80::1"],
      ["::ffff:127.0.0.1"],
    ].map((addresses) => [addresses])
  )("rejects DNS answer set %j", (addresses) => {
    expectRejected("https://staging.example.com:8443/app", addresses);
  });

  it("fails closed on DNS errors or empty answers", () => {
    expectRejected("https://staging.example.com:8443/app", "error");
    expectRejected("https://staging.example.com:8443/app", []);
  });
});

describe("zap target: allow public HTTP and HTTPS targets", () => {
  it.each([
    "http://8.8.8.8/",
    "https://1.1.1.1:8443/app?query=value",
    "https://[2606:4700:4700::1111]/",
    "http://[::ffff:8.8.8.8]/",
    "http://172.15.255.254/",
    "https://172.32.0.1/",
  ])("accepts %s", (target) => {
    expectAccepted(target);
  });

  it.each(["http", "https"])(
    "accepts public dual-stack DNS via %s",
    (scheme) => {
      expectAccepted(`${scheme}://staging.example.com:8443/app?x=1`, [
        "8.8.8.8",
        "2606:4700:4700::1111",
      ]);
    }
  );
});
