import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import type { LeaseOwnerLiveness, TurnLeaseOwner } from "../../../execution";
import { isProcessPossiblyAlive } from "../storage/file-lock";

/**
 * Leases record this process's host name, pid, and (on Linux) start time,
 * boot id, and PID namespace. Another owner is gone once it ran on this host
 * name, in this boot and PID namespace whenever this process knows them, and
 * no process has its pid or one that started at a different time holds it.
 * Owners on other hosts, and owners that lack an identity fact this process
 * has, are never proven gone: containers sharing a host name may see each
 * other's pids in different PID namespaces.
 */
export function createProcessOwnerLiveness(): LeaseOwnerLiveness {
  const host = hostname();
  const started = processStartTime(process.pid);
  const bootId = readProc(() =>
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  );
  const pidNamespace = readProc(() => readlinkSync("/proc/self/ns/pid"));
  const sharesPidSpace = (owner: TurnLeaseOwner): boolean =>
    owner.hostname === host &&
    (bootId === undefined || owner.bootId === bootId) &&
    (pidNamespace === undefined || owner.pidNamespace === pidNamespace);
  return {
    isGone: (owner) => {
      if (!sharesPidSpace(owner) || owner.pid === undefined) {
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
      ...(bootId === undefined ? {} : { bootId }),
      hostname: host,
      pid: process.pid,
      ...(pidNamespace === undefined ? {} : { pidNamespace }),
      ...(started === undefined ? {} : { processStart: started }),
    },
  };
}

/** A non-empty `/proc` fact, or undefined where `/proc` lacks it. */
function readProc(read: () => string): string | undefined {
  try {
    return read() || undefined;
  } catch {
    return;
  }
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
