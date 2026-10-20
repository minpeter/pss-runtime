import type { RuntimeToolRetryPolicy } from "@minpeter/pss-runtime/execution";
import type { ToolSet } from "ai";
import { createDeleteFileTool } from "./delete-file";
import { createEditFileTool } from "./edit-file";
import { createGlobFilesTool } from "./glob-files";
import { createGrepFilesTool } from "./grep-files";
import { createReadFileTool } from "./read-file";
import { createShellExecuteTool } from "./shell-execute";
import { createWriteFileTool } from "./write-file";

export interface CreateWorkspaceToolsOptions {
  readonly workspace: string;
}

export function createWorkspaceTools({
  workspace,
}: CreateWorkspaceToolsOptions): ToolSet {
  // After a crash, reads run again. A mutation cut short is reported to the
  // model as interrupted instead: running it again could repeat its effect
  // (shell) or misreport one that landed (a hash-guarded write or edit).
  return {
    read_file: withRetryPolicy(createReadFileTool(workspace), "pure"),
    glob_files: withRetryPolicy(createGlobFilesTool(workspace), "pure"),
    grep_files: withRetryPolicy(createGrepFilesTool(workspace), "pure"),
    edit_file: withRetryPolicy(createEditFileTool(workspace), "interrupt"),
    write_file: withRetryPolicy(createWriteFileTool(workspace), "interrupt"),
    delete_file: withRetryPolicy(createDeleteFileTool(workspace), "interrupt"),
    shell_execute: withRetryPolicy(
      createShellExecuteTool(workspace),
      "interrupt"
    ),
  };
}

/** Declares how a crashed durable run recovers the tool's unfinished call. */
function withRetryPolicy<Definition extends object>(
  definition: Definition,
  retryPolicy: RuntimeToolRetryPolicy
): Definition & { readonly retryPolicy: RuntimeToolRetryPolicy } {
  return { ...definition, retryPolicy };
}
