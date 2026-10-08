/** Build only the explicit launch overrides; provider consent never changes transport. */
export function buildSessionLaunchMetadata({ goal, acpPermissionPolicy, agentId, transport,
  nextAction, nextActionTemplate, providerApprovalPolicy }) {
  const metadata = {};
  if (goal) metadata.goal = goal;
  if (acpPermissionPolicy) metadata.acpPermissionPolicy = acpPermissionPolicy;
  if (agentId === "codex" && transport) metadata.agentTransport = transport;
  if (nextAction) metadata.nextAction = nextAction;
  if (nextActionTemplate) metadata.nextActionTemplate = nextActionTemplate;
  if (providerApprovalPolicy === "always") metadata.providerApprovalPolicy = "always";
  return Object.keys(metadata).length > 0 ? metadata : null;
}
