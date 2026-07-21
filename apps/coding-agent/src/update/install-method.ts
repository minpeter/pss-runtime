import { spawn } from "node:child_process";
import { CODING_AGENT_PACKAGE_NAME } from "./check";

export type PackageManager = string;

export type InstallMethod =
  | { readonly kind: "global"; readonly manager: PackageManager }
  | { readonly kind: "ephemeral"; readonly runner: string }
  | { readonly kind: "unknown" };

export interface ProbeResult {
  readonly code: number;
  readonly stdout: string;
}

export type ProbeRunner = (
  command: string,
  args: readonly string[]
) => Promise<ProbeResult>;

export interface DetectInstallMethodOptions {
  readonly binPath: string;
  readonly probe?: ProbeRunner;
}

export interface PackageManagerSpec {
  readonly ephemeral?: { readonly pattern: string; readonly runner: string };
  readonly globalPathPatterns: readonly string[];
  readonly installArgs: (spec: string) => readonly string[];
  readonly name: PackageManager;
  readonly probeArgs: readonly string[];
}

export const PACKAGE_MANAGERS: readonly PackageManagerSpec[] = [
  {
    name: "pnpm",
    globalPathPatterns: ["/pnpm/global/"],
    ephemeral: { pattern: "/pnpm/dlx/", runner: "pnpm dlx" },
    probeArgs: ["list", "-g", "--depth=0", CODING_AGENT_PACKAGE_NAME],
    installArgs: (spec) => ["add", "-g", spec],
  },
  {
    name: "npm",
    globalPathPatterns: ["/lib/node_modules/", "/npm/node_modules/"],
    ephemeral: { pattern: "/_npx/", runner: "npx" },
    probeArgs: ["list", "-g", "--depth=0", CODING_AGENT_PACKAGE_NAME],
    installArgs: (spec) => ["install", "-g", spec],
  },
  {
    name: "bun",
    globalPathPatterns: ["/.bun/install/global/"],
    ephemeral: { pattern: "/.bun/install/cache/", runner: "bunx" },
    probeArgs: ["pm", "ls", "-g"],
    installArgs: (spec) => ["install", "-g", spec],
  },
  {
    name: "yarn",
    globalPathPatterns: ["/yarn/global/", "/yarn/data/global/"],
    probeArgs: ["global", "list"],
    installArgs: (spec) => ["global", "add", spec],
  },
];

export function findPackageManagerSpec(
  name: string
): PackageManagerSpec | undefined {
  return PACKAGE_MANAGERS.find((spec) => spec.name === name);
}

const PACKAGE_PATH_MARKER = `${CODING_AGENT_PACKAGE_NAME}/`;
const PROBE_TIMEOUT_MS = 3000;

export function classifyInstallPath(binPath: string): InstallMethod {
  const normalized = binPath.replaceAll("\\", "/");

  for (const spec of PACKAGE_MANAGERS) {
    if (
      spec.ephemeral !== undefined &&
      normalized.includes(spec.ephemeral.pattern)
    ) {
      return { kind: "ephemeral", runner: spec.ephemeral.runner };
    }
  }

  for (const spec of PACKAGE_MANAGERS) {
    if (
      !spec.globalPathPatterns.some((pattern) => normalized.includes(pattern))
    ) {
      continue;
    }
    if (!normalized.includes(PACKAGE_PATH_MARKER)) {
      continue;
    }
    return { kind: "global", manager: spec.name };
  }

  return { kind: "unknown" };
}

export async function detectInstallMethod({
  binPath,
  probe = defaultProbe,
}: DetectInstallMethodOptions): Promise<InstallMethod> {
  const fromPath = classifyInstallPath(binPath);
  if (fromPath.kind !== "unknown") {
    return fromPath;
  }

  const matches = await Promise.all(
    PACKAGE_MANAGERS.map(async (spec) => {
      try {
        const result = await probe(spec.name, spec.probeArgs);
        return result.stdout.includes(CODING_AGENT_PACKAGE_NAME)
          ? spec.name
          : undefined;
      } catch {
        return;
      }
    })
  );

  const found = matches.filter((manager) => manager !== undefined);
  return found.length === 1
    ? { kind: "global", manager: found[0] }
    : { kind: "unknown" };
}

const defaultProbe: ProbeRunner = (command, args) =>
  new Promise((resolvePromise) => {
    const child = spawn(command, [...args], {
      shell: false,
      timeout: PROBE_TIMEOUT_MS,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.on("error", () => resolvePromise({ code: 1, stdout }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout }));
  });
