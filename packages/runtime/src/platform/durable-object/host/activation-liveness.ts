import type { LeaseOwnerLiveness } from "../../../execution/host/types";

/**
 * A Durable Object runs one activation at a time, and its storage rejects
 * writes from earlier ones. A lease on its storage taken by any other
 * process therefore belongs to an activation that is gone.
 */
export const durableObjectOwnerLiveness: LeaseOwnerLiveness = {
  isGone: () => true,
};
