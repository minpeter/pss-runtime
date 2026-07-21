import { spawn } from "node:child_process";
import { CODING_AGENT_PACKAGE_NAME } from "./update-check";

export type PackageManager = "pnpm" | "npm" | "bun" | "yarn";

export type InstallMethod =
  | { readonly kind: "global"; readonly manager: PackageManager }
  | { readonly kind: "ephemeral"; readonly runner: "pnpm dlx" | "npx" | "bunx" }
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

interface PathRule {
  readonly method: InstallMethod;
  readonly pattern: string;
  readonly requiresPackageMarker: boolean;
}

const PACKAGE_PATH_MARKER = `${CODING_AGENT_PACKAGE_NAME}/`;
const PROBE_TIMEOUT_MS = 3000;

const PATH_RULES: readonly PathRule[] = [
  {
    pattern: "/_npx/",
    method: { kind: "ephemeral", runner: "npx" },
    requiresPackageMarker: false,
  },
  {
    pattern: "/pnpm/dlx/",
    method: { kind: "ephemeral", runner: "pnpm dlx" },
    requiresPackageMarker: false,
  },
  {
    pattern: "/.bun/install/cache/",
    method: { kind: "ephemeral", runner: "bunx" },
    requiresPackageMarker: false,
  },
  {
    pattern: "/pnpm/global/",
    method: { kind: "global", manager: "pnpm" },
    requiresPackageMarker: true,
  },
  {
    pattern: "/.bun/install/global/",
    method: { kind: "global", manager: "bun" },
    requiresPackageMarker: true,
  },
  {
    pattern: "/yarn/global/",
    method: { kind: "global", manager: "yarn" },
    requiresPackageMarker: true,
  },
  {
    pattern: "/yarn/data/global/",
    method: { kind: "global", manager: "yarn" },
    requiresPackageMarker: true,
  },
  {
    pattern: "/lib/node_modules/",
    method: { kind: "global", manager: "npm" },
    requiresPackageMarker: true,
  },
  {
    pattern: "/npm/node_modules/",
    method: { kind: "global", manager: "npm" },
    requiresPackageMarker: true,
  },
];

export function classifyInstallPath(binPath: string): InstallMethod {
  const normalized = binPath.replaceAll("\\", "/");
  for (const rule of PATH_RULES) {
    if (!normalized.includes(rule.pattern)) {
      continue;
    }
    if (
      rule.requiresPackageMarker &&
      !normalized.includes(PACKAGE_PATH_MARKER)
    ) {
      continue;
    }
    return rule.method;
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

  const candidates: readonly {
    manager: PackageManager;
    args: readonly string[];
  }[] = [
    {
      manager: "pnpm",
      args: ["list", "-g", "--depth=0", CODING_AGENT_PACKAGE_NAME],
    },
    {
      manager: "npm",
      args: ["list", "-g", "--depth=0", CODING_AGENT_PACKAGE_NAME],
    },
    { manager: "bun", args: ["pm", "ls", "-g"] },
    { manager: "yarn", args: ["global", "list"] },
  ];

  const matches = await Promise.all(
    candidates.map(async ({ manager, args }) => {
      try {
        const result = await probe(manager, args);
        return result.stdout.includes(CODING_AGENT_PACKAGE_NAME)
          ? manager
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
