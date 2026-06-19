import type { ThreadHost } from "../../../execution";
import { FileThreadStore } from "../storage/file-thread-store";

export interface NodeFileThreadHostOptions {
  readonly directory: string;
}

export function createNodeFileThreadHost({
  directory,
}: NodeFileThreadHostOptions): ThreadHost {
  return {
    kind: "thread",
    threadStore: new FileThreadStore(directory),
  };
}
