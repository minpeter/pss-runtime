import type { ThreadHost } from "../../../execution";
import { FileAttachmentStore } from "../storage/file-attachment-store";
import { FileThreadStore } from "../storage/file-thread-store";

export interface NodeFileThreadHostOptions {
  readonly directory: string;
}

export function createNodeFileThreadHost({
  directory,
}: NodeFileThreadHostOptions): ThreadHost {
  return {
    attachmentStore: new FileAttachmentStore(directory),
    kind: "thread",
    threadStore: new FileThreadStore(directory),
  };
}
