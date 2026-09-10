import { element, describeNip98Target, describeNostrKindRule } from "./signing-policy-presentation.js";

export function towerForgejoSetup(policy) {
  if (policy.id !== 'tower-forgejo-login') return null;
  const target = policy.nip98Targets?.[0];
  const assigned = (policy.assignments?.profileIds?.length || 0) + (policy.assignments?.workspaceIds?.length || 0) > 0;
  const configured = Boolean(target?.origin && !target.origin.endsWith('.invalid'));
  const section = element('section', undefined, 'wm-signing-policy-setup');
  section.dataset.testid = 'tower-forgejo-policy-setup';
  section.append(element('h3', configured && assigned && policy.enabled ? 'Setup complete' : 'Setup required'));
  const steps = element('ol');
  steps.append(
    element('li', 'Set the NIP-98 target origin to the public Tower API origin and keep the exact /api/v4/git/oidc/authorize/complete path.'),
    element('li', 'Assign an agent profile, a workspace, or both. When both are set, the session must match both.'),
    element('li', 'Save the new revision, enable the policy, then apply updated permissions to each existing session that should adopt it.'),
  );
  section.append(
    element('p', 'The shipped template is intentionally disabled and unassigned so installing Autopilot never grants signing authority by itself.'),
    steps,
  );
  return section;
}

export function summaryList(policy) {
  const list = element('dl', undefined, 'wm-signing-policy-summary');
  const rows = [
    ['Operations', (policy.operations || []).join(', ') || 'None'],
    ['Nostr kinds', (policy.eventKinds || []).join(', ') || 'None'],
    ['Profiles', policy.assignments?.profileIds?.join(', ') || (policy.assignments?.allSessions ? 'All sessions' : policy.assignments?.workspaceIds?.length ? 'Any profile' : 'No assignments')],
    ['Workspaces', policy.assignments?.workspaceIds?.join(', ') || (policy.assignments?.allSessions ? 'All sessions' : policy.assignments?.profileIds?.length ? 'Any workspace' : 'No assignments')],
    ['Revision', String(policy.revision)],
  ];
  for (const [label, value] of rows) list.append(element('dt', label), element('dd', value));
  for (const rule of policy.nostrKindRules || []) {
    list.append(element('dt', 'Custom kind constraint'), element('dd', describeNostrKindRule(rule)));
  }
  for (const target of policy.nip98Targets || []) {
    const challenge = target.challenge;
    list.append(
      element('dt', 'NIP-98 target'),
      element('dd', describeNip98Target(target)),
      element('dt', 'Challenge tags'),
      element('dd', challenge
        ? `required ${(challenge.requiredTags || []).join(', ') || 'none'}; expiry ≤ ${(challenge.allowedTags || []).find((rule) => rule.name === 'expiration')?.maxFutureSeconds || '?'} seconds`
        : 'No caller-supplied tags'),
    );
  }
  return list;
}

