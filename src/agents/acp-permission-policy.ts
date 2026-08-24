export const ACP_PERMISSION_POLICIES = ["auto_approve", "ask"] as const;

export type AcpPermissionPolicy = (typeof ACP_PERMISSION_POLICIES)[number];

export const DEFAULT_ACP_PERMISSION_POLICY: AcpPermissionPolicy = "auto_approve";
export const LEGACY_ACP_PERMISSION_POLICY: AcpPermissionPolicy = "ask";

export function parseAcpPermissionPolicy(value: unknown): AcpPermissionPolicy | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return ACP_PERMISSION_POLICIES.includes(normalized as AcpPermissionPolicy)
    ? normalized as AcpPermissionPolicy
    : null;
}
