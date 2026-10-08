import type { RequestAuthContext } from "../auth/request-context";
import { validatedNpub } from "./secret-policy";

export interface PipelineSecretAuthority { principalNpub: string; workspaceId: string }
/** Only authenticated ingress or owner-configured jobs may supply this runner field. */
export function secretAuthorityFromAuth(auth: RequestAuthContext, workspaceId = "local"): PipelineSecretAuthority | undefined {
  const principal = auth.actorNpub ?? auth.signerNpub ?? auth.npub;
  if (!principal || (auth.delegatedByBot && !auth.actorNpub && !auth.signerNpub)) return undefined;
  try { return { principalNpub: validatedNpub(principal), workspaceId }; } catch { return undefined; }
}
