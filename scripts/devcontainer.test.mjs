import { describe, expect, it } from "vitest";
import {
  DEVCONTAINER_PATH,
  hostPathProblems,
  lifecycleProblems,
  nameProblems,
  parseDevcontainer,
  portProblems,
  readRepoFile,
  referencedDockerfile,
  toolchainProblems,
} from "./devcontainer.mjs";

const raw = readRepoFile(DEVCONTAINER_PATH);
const { config, errors } = parseDevcontainer(raw);
const dockerfile = config ? referencedDockerfile(config) : null;

function validConfig(overrides = {}) {
  return {
    name: "pss-runtime",
    build: { dockerfile: "Dockerfile" },
    postCreateCommand: "pnpm install --frozen-lockfile",
    ...overrides,
  };
}

const VALID_DOCKERFILE = [
  "FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
  "RUN corepack enable && corepack prepare pnpm@11.9.0 --activate",
].join("\n");

describe("local quality: devcontainer", () => {
  it("exists, parses as valid JSON, and carries a name (VAL-LOCAL-008)", () => {
    expect(errors).toEqual([]);
    expect(nameProblems(config)).toEqual([]);
  });

  it("declares the pinned Node 24 / pnpm 11.9.0 toolchain (VAL-LOCAL-008)", () => {
    expect(config?.build?.dockerfile).toBe("Dockerfile");
    expect(dockerfile).not.toBeNull();
    expect(toolchainProblems(config, dockerfile)).toEqual([]);
  });

  it("rejects configs without a Node 24 or pnpm 11.9.0 pin (VAL-LOCAL-008)", () => {
    expect(toolchainProblems(validConfig(), VALID_DOCKERFILE)).toEqual([]);
    expect(
      toolchainProblems(validConfig(), "FROM node:22-alpine\nRUN true")
    ).not.toEqual([]);
    expect(
      toolchainProblems(
        validConfig(),
        "FROM node:24-bookworm-slim\nRUN corepack prepare pnpm@10.0.0 --activate"
      )
    ).not.toEqual([]);
    // An image-only config without a pnpm pin is rejected.
    expect(
      toolchainProblems(
        {
          name: "x",
          image: "node:24-bookworm-slim",
          postCreateCommand: "pnpm install --frozen-lockfile",
        },
        null
      )
    ).not.toEqual([]);
    // The devcontainers/node feature with a 24.x version pin also qualifies.
    expect(
      toolchainProblems(
        {
          name: "x",
          features: {
            "ghcr.io/devcontainers/features/node:1": { version: "24.18.0" },
          },
          postCreateCommand:
            "corepack prepare pnpm@11.9.0 --activate && pnpm install --frozen-lockfile",
        },
        null
      )
    ).toEqual([]);
  });

  it("references no host paths or host environment (VAL-LOCAL-008)", () => {
    expect(hostPathProblems(config)).toEqual([]);
  });

  it("rejects bind mounts and host environment references (VAL-LOCAL-008)", () => {
    expect(
      hostPathProblems(
        validConfig({ mounts: ["source=/home/u/.ssh,target=/ssh,type=bind"] })
      )
    ).not.toEqual([]);
    expect(
      hostPathProblems(
        validConfig({
          workspaceMount: `source=${"$"}{localWorkspaceFolder},target=/ws,type=bind`,
        })
      )
    ).not.toEqual([]);
    expect(
      hostPathProblems(
        validConfig({ remoteEnv: { KEY: `${"$"}{localEnv:HOST_SECRET}` } })
      )
    ).not.toEqual([]);
  });

  it("lifecycle installs with frozen-lockfile semantics only (VAL-LOCAL-009)", () => {
    expect(lifecycleProblems(config)).toEqual([]);
  });

  it("rejects lifecycle commands beyond the install (VAL-LOCAL-009)", () => {
    expect(
      lifecycleProblems(
        validConfig({
          postCreateCommand: "pnpm install --frozen-lockfile && pnpm test",
        })
      )
    ).not.toEqual([]);
    expect(
      lifecycleProblems(
        validConfig({ postCreateCommand: "pnpm install && pnpm build" })
      )
    ).not.toEqual([]);
    expect(
      lifecycleProblems(
        validConfig({
          postCreateCommand: "pnpm install --frozen-lockfile",
          postStartCommand:
            "pnpm --filter @minpeter/pss-worker-agent dev:worker",
        })
      )
    ).not.toEqual([]);
    expect(
      lifecycleProblems(
        validConfig({
          postCreateCommand: "pnpm install --frozen-lockfile; env",
        })
      )
    ).not.toEqual([]);
  });

  it("rejects credential-shaped lifecycle content (VAL-LOCAL-009)", () => {
    const token = `ghp_${"A".repeat(30)}`;
    expect(
      lifecycleProblems(
        validConfig({
          postCreateCommand: `pnpm install --frozen-lockfile # ${token}`,
        })
      )
    ).not.toEqual([]);
    expect(
      lifecycleProblems(
        validConfig({
          postCreateCommand:
            "npm config set //registry.npmjs.org/:_authToken x && pnpm install --frozen-lockfile",
        })
      )
    ).not.toEqual([]);
  });

  it("forwards or exposes no port (VAL-LOCAL-011)", () => {
    expect(portProblems(config)).toEqual([]);
    expect(config?.forwardPorts ?? []).toEqual([]);
    expect(config?.appPort).toBeUndefined();
  });

  it("allows exactly 8792 but rejects any other port (VAL-LOCAL-011)", () => {
    expect(portProblems(validConfig({ forwardPorts: [8792] }))).toEqual([]);
    expect(portProblems(validConfig({ forwardPorts: [3000] }))).not.toEqual([]);
    expect(portProblems(validConfig({ forwardPorts: [8788] }))).not.toEqual([]);
    expect(portProblems(validConfig({ appPort: [3401] }))).not.toEqual([]);
    expect(
      portProblems(validConfig({ portsAttributes: { 3402: {} } }))
    ).not.toEqual([]);
    expect(
      portProblems(validConfig({ runArgs: ["-p", "8080:8080"] }))
    ).not.toEqual([]);
  });
});
