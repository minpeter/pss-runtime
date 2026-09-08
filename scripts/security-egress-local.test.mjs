import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXAMPLE_ENV_FILES,
  exampleEnvProblems,
  nonLoopbackProblems,
  scriptPortProblems,
  WRANGLER_CONFIG_PATH,
  wranglerBindingProblems,
} from "./security-egress-local.mjs";

// Example-env placeholder and loopback-binding invariants
// (VAL-SEC-041/042): example env files carry placeholders only, the Wrangler
// dev binding is 127.0.0.1/8792, and no script opens another port or binds a
// non-loopback address. Static over committed files and pure fixtures.

// Credential-shaped fixture values are built at runtime so no scanner ever
// sees a full token literal in source.
const FAKE_API_KEY = ["sk", "A1b2".repeat(10)].join("-");
const FAKE_TELEGRAM_TOKEN = ["123456789", "aB3".repeat(12)].join(":");
const FAKE_ENTROPY_VALUE = "xY7".repeat(12);
// Built at runtime so the shipped-tree non-loopback-address ban never
// self-flags the fixtures in this file.
const NON_LOOPBACK_IP = ["0", "0", "0", "0"].join(".");
const SCRIPT_FILE = /\.m[jt]s$/;

describe("example env placeholders (VAL-SEC-041)", () => {
  it("shipped example env files carry placeholders only", () => {
    for (const path of EXAMPLE_ENV_FILES) {
      expect(exampleEnvProblems(path, readFileSync(path, "utf8"))).toEqual([]);
    }
  });

  it("fails on a high-entropy value and a real-looking sensitive value", () => {
    const problems = exampleEnvProblems(
      "fixture/.dev.vars.example",
      `AI_API_KEY=${FAKE_API_KEY}\n` +
        `TELEGRAM_BOT_TOKEN=${FAKE_TELEGRAM_TOKEN}\n` +
        `SESSION_ID=${FAKE_ENTROPY_VALUE}\n`
    );
    expect(problems.some((p) => p.includes("AI_API_KEY"))).toBe(true);
    expect(problems.some((p) => p.includes("TELEGRAM_BOT_TOKEN"))).toBe(true);
    expect(problems.some((p) => p.includes("SESSION_ID"))).toBe(true);
  });

  it("accepts empty, ellipsis, bracketed, and config-shaped values", () => {
    const problems = exampleEnvProblems(
      "fixture/.env.example",
      "AI_API_KEY=\n" +
        "TELEGRAM_BOT_TOKEN=...\n" +
        "WORKER_PUBLIC_URL=https://pss-worker-agent.<account>.workers.dev\n" +
        "AI_MODEL=minimax/MiniMax-M3\n" +
        "LOCAL_WEBHOOK_URL=http://127.0.0.1:8792/\n"
    );
    expect(problems).toEqual([]);
  });

  it("fails on an unparseable line", () => {
    const problems = exampleEnvProblems("fixture/.env.example", "not a kv\n");
    expect(problems.some((p) => p.includes("KEY=value"))).toBe(true);
  });

  it("accepts the documented pss_local_..._placeholder webhook sentinel", () => {
    const problems = exampleEnvProblems(
      "fixture/.dev.vars.example",
      "TELEGRAM_WEBHOOK_SECRET_TOKEN=pss_local_webhook_secret_placeholder\n"
    );
    expect(problems).toEqual([]);
  });

  it("still rejects a real-looking value that merely resembles the sentinel", () => {
    // An uppercase/digit-bearing token is not the documented placeholder and
    // must still fail, even when it shares the pss_local_ prefix. Built at
    // runtime so no credential-shaped literal ever sits in source.
    const realLooking = ["pss_local", "Webhook", "Secret9"].join("_");
    const problems = exampleEnvProblems(
      "fixture/.dev.vars.example",
      `TELEGRAM_WEBHOOK_SECRET_TOKEN=${realLooking}\n`
    );
    expect(
      problems.some((p) => p.includes("TELEGRAM_WEBHOOK_SECRET_TOKEN"))
    ).toBe(true);
  });
});

describe("loopback-only local validation (VAL-SEC-042)", () => {
  it("wrangler.jsonc dev binding is 127.0.0.1/8792", () => {
    expect(
      wranglerBindingProblems(readFileSync(WRANGLER_CONFIG_PATH, "utf8"))
    ).toEqual([]);
  });

  it("fails on a non-loopback ip, a different port, or an env override", () => {
    const base = {
      name: "w",
      main: "src/index.ts",
      dev: { ip: "127.0.0.1", port: 8792 },
    };
    const asJsonc = (config) =>
      `${JSON.stringify(config, null, 2)}\n// comment\n`;
    expect(
      wranglerBindingProblems(
        asJsonc({ ...base, dev: { ip: NON_LOOPBACK_IP, port: 8792 } })
      ).some((p) => p.includes(NON_LOOPBACK_IP))
    ).toBe(true);
    expect(
      wranglerBindingProblems(
        asJsonc({ ...base, dev: { ip: "127.0.0.1", port: 8788 } })
      ).some((p) => p.includes("8788"))
    ).toBe(true);
    expect(
      wranglerBindingProblems(
        asJsonc({ ...base, env: { dev: { dev: { port: 3000 } } } })
      ).some((p) => p.includes("env.dev.dev"))
    ).toBe(true);
    expect(wranglerBindingProblems("name: not json")).not.toEqual([]);
  });

  it("no script binds a non-loopback address or another port", () => {
    const scripts = readdirSync("scripts")
      .filter((file) => SCRIPT_FILE.test(file))
      .sort();
    for (const file of scripts) {
      const path = `scripts/${file}`;
      const source = readFileSync(path, "utf8");
      const problems = file.endsWith(".test.mjs")
        ? nonLoopbackProblems(path, source)
        : scriptPortProblems(path, source);
      expect(problems, path).toEqual([]);
    }
  });

  it("fails on scripts that listen elsewhere or bind non-loopback", () => {
    expect(
      scriptPortProblems("fixture.mjs", "server.listen(3000);\n")
    ).not.toEqual([]);
    expect(
      scriptPortProblems("fixture.mjs", 'run("wrangler dev --port 8788");\n')
    ).not.toEqual([]);
    expect(
      scriptPortProblems(
        "fixture.mjs",
        `run("serve --host ${NON_LOOPBACK_IP}");\n`
      )
    ).not.toEqual([]);
    expect(
      scriptPortProblems("fixture.mjs", 'run("wrangler dev --port 8792");\n')
    ).toEqual([]);
    expect(
      nonLoopbackProblems("fixture.mjs", `ip("${NON_LOOPBACK_IP}");\n`)
    ).not.toEqual([]);
  });
});
