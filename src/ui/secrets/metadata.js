function pick(record, keys) { return Object.fromEntries(keys.map(key => [key, record[key]])); }

export function hostedSiteGrantMetadata(record) {
  return pick(record, ["id", "ownerNpub", "workspaceId", "appId", "appRoot", "secretId", "secretRevision", "siteNpub", "url", "expiresAt", "revoked", "credentialFile"]);
}

// Explicit nested projection prevents later API additions from caching credentials.
export function secretMetadata(record) {
  const metadata = pick(record, ["id", "label", "type", "ownerNpub", "workspaceId", "publicNpub", "revision",
    "createdAt", "updatedAt", "revokedAt", "lastUsedAt"]);
  metadata.policy = pick(record.policy, ["identities", "allowExport"]);
  metadata.policy.kindMode = record.policy.kindMode ?? "selected";
  for (const context of ["pipelines", "agents"]) metadata.policy[context] = pick(record.policy[context], ["enabled", "mode", "ids"]);
  metadata.policy.kindRules = record.policy.kindRules.map(rule => pick(rule,
    ["kind", "maxContentBytes", "maxTags", "maxTagBytes", "allowedTagNames", "requiredTags", "exactTags"]));
  return metadata;
}
