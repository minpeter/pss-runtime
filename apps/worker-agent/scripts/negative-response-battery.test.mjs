import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURE_BASE = ".omo/tmp";
const scope = (() => {
  const dirs = [];
  return {
    dir() {
      mkdirSync(FIXTURE_BASE, { recursive: true });
      const dir = mkdtempSync(join(FIXTURE_BASE, "negative-battery-"));
      dirs.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of dirs.splice(0)) {
        rmSync(dir, { force: true, recursive: true });
      }
    },
  };
})();
const battery = fileURLToPath(
  new URL("./negative-response-battery.mjs", import.meta.url)
);
afterEach(scope.cleanup);

function fixture() {
  const cwd = resolve(scope.dir());
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const calls = join(cwd, "calls.jsonl");
  // Exercise the real CLI up to curl's process boundary, without opening a
  // socket or transmitting any token. Each synthetic response is audited.
  writeFileSync(
    join(bin, "curl.cjs"),
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
writeFileSync(args[args.indexOf("-o") + 1], "unauthorized");
writeFileSync(args[args.indexOf("-D") + 1], "HTTP/1.1 401 Unauthorized\\n");
process.stdout.write("401");
`,
    { mode: 0o755 }
  );
  symlinkSync("curl.cjs", join(bin, "curl"));
  const out = join(cwd, "evidence");
  return {
    calls,
    out,
    run(base) {
      return spawnSync(
        process.execPath,
        [
          battery,
          "--out",
          out,
          "--tui-token",
          "placeholder-token",
          "--base",
          base,
        ],
        {
          cwd,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
          },
          encoding: "utf8",
          timeout: 10_000,
        }
      );
    },
  };
}

describe("negative battery local target validation", () => {
  it.each([
    "https://example.com",
    "http://127.0.0.1:8793",
    "http://localhost:8792",
    "http://127.0.0.1:8792@remote.invalid",
    "http://user:pass@127.0.0.1:8792",
    "http://127.0.0.1:8792/path",
    "http://127.0.0.1:8792?next=remote",
    "http://127.0.0.1:8792#fragment",
    "file:///tmp/local",
    "not a URL",
  ])("rejects %s before curl or evidence writes", (base) => {
    const f = fixture();
    const result = f.run(base);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(existsSync(f.calls)).toBe(false);
    expect(existsSync(f.out)).toBe(false);
    expect(result.stderr).not.toContain("placeholder-token");
  });

  it("normalizes the local origin and disables curl config and proxy routing", () => {
    const f = fixture();
    const result = f.run("http://127.0.0.1:8792/");
    expect(result.error).toBeUndefined();
    // The stub intentionally returns 401 for all probes: status auditing
    // must still fail probes expecting 400/404/405.
    expect(result.status).toBe(1);
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    expect(calls).toHaveLength(16);
    for (const args of calls) {
      expect(args[0]).toBe("--disable");
      expect(args[args.indexOf("--noproxy") + 1]).toBe("*");
      const url = new URL(args.at(-1));
      expect(url.origin).toBe("http://127.0.0.1:8792");
      expect(url.pathname.startsWith("//")).toBe(false);
    }
    expect(existsSync(join(f.out, "audit.txt"))).toBe(true);
  });
});
