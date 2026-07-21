import { describe, expect, it } from "vitest";
import { runUpdateCommand } from "./command";
import type { InstallMethod } from "./install-method";

interface Harness {
  readonly output: () => string;
  readonly run: () => Promise<number>;
  readonly spawns: readonly { command: string; args: readonly string[] }[];
}

const DEFAULT_METHOD: InstallMethod = { kind: "global", manager: "pnpm" };
const DEFAULT_PLATFORM: NodeJS.Platform = "linux";

function createHarness(
  options: {
    args?: readonly string[];
    version?: string | undefined;
    method?: InstallMethod;
    tags?: Readonly<Partial<Record<"latest" | "next", string>>>;
    spawnExitCode?: number;
    platform?: NodeJS.Platform;
  } = {}
): Harness {
  const {
    args = [],
    method = DEFAULT_METHOD,
    tags = { latest: "0.0.14" },
    spawnExitCode = 0,
    platform = DEFAULT_PLATFORM,
  } = options;
  const version = "version" in options ? options.version : "0.0.13";
  let output = "";
  const spawns: { command: string; args: readonly string[] }[] = [];

  return {
    output: () => output,
    spawns,
    run: () =>
      runUpdateCommand({
        args,
        stdout: {
          write(text: string): void {
            output += text;
          },
        },
        env: {},
        version,
        binPath: "/irrelevant/bin/pss.js",
        platform,
        fetchTags: () => Promise.resolve(tags),
        detectInstall: () => Promise.resolve(method),
        spawnInstall: (command, args) => {
          spawns.push({ command, args });
          return Promise.resolve(spawnExitCode);
        },
      }),
  };
}

describe("pss update", () => {
  it("updates through the detected manager with an exact pinned version", async () => {
    const harness = createHarness({});

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@0.0.14"],
      },
    ]);
    expect(harness.output()).toContain("0.0.13");
    expect(harness.output()).toContain("0.0.14");
    expect(harness.output()).toContain("Restart pss");
  });

  it("routes installs through cmd.exe on Windows", async () => {
    const harness = createHarness({ platform: "win32" });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          "pnpm",
          "add",
          "-g",
          "@minpeter/pss-coding-agent@0.0.14",
        ],
      },
    ]);
  });

  it("reports already up to date without spawning", async () => {
    const harness = createHarness({ tags: { latest: "0.0.13" } });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("up to date");
    expect(harness.spawns).toEqual([]);
  });

  it("stays put when the installed version is ahead of its channel tag", async () => {
    const harness = createHarness({
      version: "0.0.15",
      tags: { latest: "0.0.14" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("up to date");
    expect(harness.spawns).toEqual([]);
  });

  it("refuses a dev build without a baked version", async () => {
    const harness = createHarness({ version: undefined });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("global");
    expect(harness.spawns).toEqual([]);
  });

  it("refuses an ephemeral dlx or npx install", async () => {
    const harness = createHarness({
      method: { kind: "ephemeral", runner: "npx" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("npx");
    expect(harness.output()).toContain("pnpm add -g");
    expect(harness.spawns).toEqual([]);
  });

  it("prints manual instructions when the install method is unknown", async () => {
    const harness = createHarness({ method: { kind: "unknown" } });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("pnpm add -g");
    expect(harness.output()).toContain("npm install -g");
    expect(harness.spawns).toEqual([]);
  });

  it("fails when the registry cannot provide the target channel", async () => {
    const harness = createHarness({ tags: {} });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.spawns).toEqual([]);
  });

  it("propagates the installer exit code and prints the manual command", async () => {
    const harness = createHarness({ spawnExitCode: 3 });

    const exitCode = await harness.run();

    expect(exitCode).toBe(3);
    expect(harness.output()).toContain(
      "pnpm add -g @minpeter/pss-coding-agent@0.0.14"
    );
  });

  it("keeps a next-channel install on the next channel by default", async () => {
    const harness = createHarness({
      version: "0.0.14-next.1",
      tags: { latest: "0.0.13", next: "0.0.14-next.2" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@0.0.14-next.2"],
      },
    ]);
  });

  it("moves a next-channel install to stable when --channel latest is explicit", async () => {
    const harness = createHarness({
      args: ["--channel", "latest"],
      version: "0.0.14-next.2",
      tags: { latest: "0.0.14", next: "0.0.14-next.2" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@0.0.14"],
      },
    ]);
  });

  it("rejects a stable install switching to the next channel", async () => {
    const harness = createHarness({
      args: ["--channel", "next"],
      version: "0.0.13",
      tags: { latest: "0.0.14", next: "0.0.15-next.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("next");
    expect(harness.spawns).toEqual([]);
  });

  it("rejects unknown arguments", async () => {
    const harness = createHarness({ args: ["--bogus"] });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("pss update");
    expect(harness.spawns).toEqual([]);
  });

  it("describes the update without changing anything for --check", async () => {
    const harness = createHarness({ args: ["--check"] });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("0.0.13");
    expect(harness.output()).toContain("latest");
    expect(harness.output()).toContain("pnpm");
    expect(harness.output()).toContain(
      "pnpm add -g @minpeter/pss-coding-agent@0.0.14"
    );
    expect(harness.spawns).toEqual([]);
  });

  it("stays put for --check when the installed version is ahead of its channel", async () => {
    const harness = createHarness({
      args: ["--check"],
      version: "0.0.15",
      tags: { latest: "0.0.14" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("up to date");
    expect(harness.output()).not.toContain("would run");
    expect(harness.spawns).toEqual([]);
  });

  it("previews an explicit channel switch even when it lowers the version", async () => {
    const harness = createHarness({
      args: ["--check", "--channel", "latest"],
      version: "0.0.15-next.0",
      tags: { latest: "0.0.14", next: "0.0.15-next.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("0.0.15-next.0 -> 0.0.14");
    expect(harness.output()).toContain(
      "pnpm add -g @minpeter/pss-coding-agent@0.0.14"
    );
    expect(harness.spawns).toEqual([]);
  });

  it("still reports registry state for --check on a dev build", async () => {
    const harness = createHarness({ args: ["--check"], version: undefined });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("dev");
    expect(harness.output()).toContain("0.0.14");
    expect(harness.spawns).toEqual([]);
  });
});
