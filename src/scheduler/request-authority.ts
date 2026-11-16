import { getRequestContext } from "../auth/request-context";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import { isInstanceAdmin } from "../auth/admin-authority";

export function schedulerRequestAuthority(isAdminNpub: (npub: string | null | undefined) => boolean) {
  return {
    getNpub: (_request: Request) => getEffectiveOwnerNpub(getRequestContext()),
    isAdmin: () => isInstanceAdmin(getRequestContext(), isAdminNpub),
    // Owner-space routes attach an execution scope even for admin/self access.
    listAllJobs: () => !getRequestContext().delegateExecutionScope,
  };
}
