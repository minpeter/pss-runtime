import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { LeaseOwnerLiveness } from "../../../execution";
import { isProcessPossiblyAlive } from "../storage/file-lock";

/**
 * Leases record this process's host name, pid, and (on Linux) start time.
 * Another owner on the same host is gone once no process has its pid, or
 * once a process that started at a different time holds that pid. Like the
 * file lock, this assumes one PID namespace per host name; owners on other
 * hosts are never proven gone.
 */
export function createProcessOwnerLiveness(): LeaseOwnerLiveness {
  const host = hostname();
  const started = processStartTime(process.pid);
  return {
    isGone: (owner) => {
      if (owner.hostname !== host || owner.pid === undefined) {
        return false;
      }
      if (!isProcessPossiblyAlive(owner.pid)) {
        return true;
      }
      const current =
        owner.processStart === undefined
          ? undefined
          : processStartTime(owner.pid);
      return current !== undefined && current !== owner.processStart;
    },
    self: {
      hostname: host,
      pid: process.pid,
      ...(started === undefined ? {} : { processStart: started }),
    },
  };
}

/** The process's start time in clock ticks since boot, where `/proc` has it. */
function processStartTime(pid: number): string | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return;
  }
  // The command name may hold spaces; fields after it are space-separated,
  // starting at the state, and the start time is the 20th of them.
  return stat
    .slice(stat.lastIndexOf(")") + 2)
    .split(" ")
    .at(19);
}
