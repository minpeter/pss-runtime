import { FileSessionStore } from "../session/store/file";
import { MemorySessionStore } from "../session/store/memory";
import type { SessionStore } from "../session/store/types";
import { definePlugin } from "./types";

export const sessions = {
  custom(store: SessionStore) {
    return definePlugin({
      name: "sessions.custom",
      setup(host) {
        host.registerSessionStore(store);
      },
    });
  },
  file(directory: string) {
    return definePlugin({
      name: "sessions.file",
      setup(host) {
        host.registerSessionStore(new FileSessionStore(directory));
      },
    });
  },
  inMemory() {
    return definePlugin({
      name: "sessions.inMemory",
      setup(host) {
        host.registerSessionStore(new MemorySessionStore());
      },
    });
  },
} as const;
