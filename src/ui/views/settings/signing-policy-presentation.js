export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function describeNostrKindRule(rule) {
  const required = rule.requiredTags?.length
    ? rule.requiredTags.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ')
    : 'none';
  const exact = rule.exactTags?.length
    ? `; exactly once (full tag) ${rule.exactTags.map((tag) => JSON.stringify(tag)).join(', ')}`
    : '';
  return `Kind ${rule.kind}: content ≤ ${rule.maxContentBytes} bytes; tags ≤ ${rule.maxTags} / ${rule.maxTagBytes} bytes; names ${rule.allowedTagNames.join(', ') || 'none'}; required ${required}${exact}`;
}

export function describeNip98Target(target = {}) {
  const exactPaths = (target.exactPaths || [])
    .map((entry) => typeof entry === 'string' ? entry : entry?.path)
    .filter(Boolean);
  const pathPrefixes = (target.pathPrefixes || []).filter(Boolean);
  const methods = [...new Set([
    ...(target.methods || []),
    ...(target.exactPaths || []).flatMap((entry) => typeof entry === 'object' ? entry?.methods || [] : []),
  ])];
  const requireBodyHash = target.requireBodyHash === true || (target.requireBodyHashMethods || []).length > 0;
  return `${target.origin || 'origin not configured'} · ${methods.join('/') || 'no methods'} · exact ${exactPaths.join(', ') || 'none'} · prefixes ${pathPrefixes.join(', ') || 'none'} · payload hash ${requireBodyHash ? 'required' : 'optional'}`;
}

export function identifier(value) {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

export function policyStatus(policy) {
  if (policy.builtIn === "baseline") return "Built-in · Always enabled · Read-only";
  return `${policy.enabled ? "Enabled" : "Disabled"}${policy.builtIn ? " · Built-in template" : ""}`;
}

export function disclosure(label, testId) {
  const details = element("details");
  details.dataset.testid = testId;
  const summary = element("summary", label);
  summary.setAttribute("aria-label", label);
  details.append(summary);
  return details;
}

export function overview(policy) {
  const section = element("section", undefined, "wm-signing-policy-overview");
  section.dataset.testid = "signing-policy-overview";
  const names = {
    "identity.read": "Read signer identity", "capability.refresh": "Refresh session capability",
    "nip98.sign": "Sign HTTP authentication requests (NIP-98)", "nostr.sign": "Sign Nostr events",
    "nip44.encrypt": "Encrypt messages (NIP-44)", "nip44.decrypt": "Decrypt messages (NIP-44)",
    "blossom.authorize": "Authorize Blossom file requests",
  };
  const actions = element("ul");
  for (const operation of policy.operations || []) actions.append(element("li", names[operation] || operation));
  section.append(element("h3", "What it permits"), actions);
  if (policy.eventKinds?.length) section.append(element("p", `Event kinds: ${policy.eventKinds.join(", ")}. Exact event and tag restrictions are available in Advanced.`));
  const origins = [...new Set((policy.nip98Targets || []).map((target) => target.origin))];
  section.append(element("p", origins.length ? `HTTP destinations: ${origins.join(", ")}. Only the methods and paths listed in Advanced are allowed.` : "No HTTP destinations granted by this policy."));
  section.append(element("p", policy.builtIn === "baseline" ? "This is the starting permission set for every session. Enabled assigned policies can add permissions." : "This policy adds permissions to the built-in baseline and other assigned policies. Event tags constrain signed content; they do not control where it is published."));
  section.append(element("h3", "Who receives permission"));
  const { profileIds = [], workspaceIds = [], allSessions } = policy.assignments || {};
  const scope = allSessions ? "Every session receives the built-in baseline."
    : !profileIds.length && !workspaceIds.length ? "No sessions: assign a profile or workspace in Advanced before enabling."
    : profileIds.length && workspaceIds.length ? "Sessions must match one listed profile AND one listed workspace."
    : profileIds.length ? "Sessions matching one listed profile, in any workspace."
    : "Sessions in one listed workspace, with any profile.";
  section.append(element("p", scope));
  for (const [label, ids] of [["Profile", profileIds], ["Workspace", workspaceIds]]) {
    if (!ids.length) continue;
    const details = disclosure(`${label} IDs (${ids.length}): ${ids.map(identifier).join(", ")}`, `signing-policy-${label.toLowerCase()}-ids`);
    for (const id of ids) details.append(element("p", `${label} ID: ${id}`));
    section.append(details);
  }
  if (!policy.enabled) section.append(element("p", "Disabled: new sessions do not receive this policy. Existing sessions may still hold an earlier permission snapshot."));
  return section;
}
