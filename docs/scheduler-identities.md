# Scheduler identities and owner authorization

A scheduled job saves an explicit owner (`userNpub`) and execution identity
(`botNpub`). Authorization to manage that owner space is separate from the
availability of its execution identity. Admin privileges do not make an unknown
identity valid or transfer a registered bot to another owner.

Use `/api/owners/<owner-npub>/scheduler/identities` to discover identities in an
explicit owner space, and the adjacent `/scheduler/jobs` routes to create,
update, list, trigger or inspect runs there. These routes authorize the actual
signer as the owner, a current instance admin, or an active delegate with the
required scope. Reads require `sessions:read`, creation `sessions:create`, and
other mutations `sessions:manage`; resource filters still apply. The signer is
preserved. Raw `/api/scheduler` requests retain the caller's namespace; they do
not infer an owner from the bot's registry entry. Raw admin job listing can see
all jobs, while explicit owner-space listings stay scoped even for admins.

The shared scheduler identity policy requires an enabled, unarchived agent
profile in the selected owner space and one supported signing source:

- An active registered bot key owned by that exact owner, with a provisioned
  broker vault entry.
- The exact configured Wingman instance npub, explicitly bound to that owner's
  active profile. It does not need a synthetic bot-key registration. An existing
  active bot-key record takes precedence and must pass its ownership checks,
  matching the capability broker.

The instance signing configuration must be available. Profile creation or
delegation is not granted by the scheduler. Knowing the instance npub alone
does not grant access to any owner's profiles, jobs or signing identity.

Discovery and create/rebind/enable validation use the same policy. Execution
rechecks the live policy for both session and pipeline actions before launching
work. A revoked key, disabled/archived profile, removed instance configuration
or unavailable vault entry cannot launch work. Failed execution records an
error run without claiming success. Session Flight Deck bindings independently
require their exact live owner, bot, subscription, workspace and transport;
instance identity support does not relax those checks.

Historical invalid jobs remain visible. They can be disabled and edited while
disabled, or deleted, without replacing their identity. Saving an enabled job,
rebinding its identity or changing to an identity-bearing action validates the
resulting pair. Cleanup actions remain identity-free.

For an incorrectly owned historical job, first identify the intended owner and
its active profile, pipeline namespace and any exact Flight Deck binding. Use
the authorized API to create a disabled replacement in that owner space, verify
its saved fields, then disable the old job. Owner changes are not an implicit
PATCH operation. Activation and any execution with external effects require
their normal operational authorization. Never substitute a different bot,
insert a synthetic key registration, or edit the scheduler database to hide an
ownership mismatch.
