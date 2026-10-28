import type { RequestAuthContext } from "./request-context";
import { normaliseNpub } from "../identity/npub-utils";

/** The authenticated subject, never a target owner or identity custodian. */
export function adminPrincipal(auth: RequestAuthContext): string | null {
  return normaliseNpub(auth.subjectNpub ?? auth.signerNpub ?? auth.actorNpub ?? auth.npub);
}

export function isInstanceAdmin(auth: RequestAuthContext, isAdmin: (npub: string | null | undefined) => boolean): boolean {
  return isAdmin(adminPrincipal(auth));
}
