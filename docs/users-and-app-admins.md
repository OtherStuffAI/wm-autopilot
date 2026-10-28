# Users and app administrators

Settings → Users lists registered humans and known stable bot identities, including
active profiles that have never signed in interactively. Profile labels identify
agents; matching normalized public keys produce one row. Role changes use the
existing durable identity-user registry. The browser caches the authorized Users
snapshot in IndexedDB, scoped to the signed-in administrator; this cache never
grants API authority.

An existing administrator can check **Is Admin** for a human or stable bot.
Configured bootstrap administrators cannot be demoted or deleted while configured.
The final effective administrator cannot be removed. Normal access approval remains
separate from the admin checkbox and retains its existing onboarding behavior.

An explicitly appointed administrator can read, list, configure, build, operate and
deploy every app on the instance, including protected core app management. App
ownership remains attribution. A bot signs as itself: its creator, profile
custodian, linked human and session owner do not confer this role. Narrow existing
delegation and owner-local nonadmin access remain available.

Ordinary app routes and `/api/owners/<owner>/apps` accept this authority. The latter
still selects the named owner's apps and preserves that owner when creating an app.
App operation authorization checks the current authenticated principal, including
when the target owner has no normal access approval.

For ordinary standard-agent and full-Nostr sessions, the broker checks the current
bot role on every request. Admins can sign supported server administration requests
at the configured Autopilot origin, including owner routes, WApps, sessions,
pipelines, schedules, settings and Users. Existing sessions gain promotions and
lose demotions without capability reissue. The API independently checks the current
role. Deliberate no-signing and narrower capabilities keep their restrictions.

Admins sign Nostr events as themselves beyond the standard kind list, with protocol
validators and content/tag limits intact. NIP-44 uses the session identity and the
ordinary wildcard peer policy; narrow peer policies remain narrow. External Tower
ACLs, wallet spending budgets, credential custody and other-identity signing grants
remain separate. See [Admin signing and authorization](admin-signing-and-authorization.md)
for the complete operation/route inventory, binding rules and explicit exceptions.

Deactivated bot keys and disabled/archived profiles cease to supply effective admin
authority immediately. Stored role attribution is retained, so reactivation restores
an explicitly retained role; demote the identity to remove that assignment. Bootstrap
configuration remains authoritative. Startup marks recoverable legacy bot user records
using current public key/profile metadata, preserving classification after later deletion.
If all bot metadata was deleted before the upgraded source first runs, that legacy
identity cannot be reliably distinguished from a human; review and demote such orphaned
assignments explicitly. Removing a user record removes its stored role;
an active bot may still appear as a discovered nonadmin identity.

This is an Autopilot app authority change. Tower permissions, pipeline/scheduler
ownership, exact-session queue restrictions, arbitrary external signing and
human-only key-export controls retain their separate rules. No runtime restart,
deployment or live role change is part of source implementation. An operator must
activate the reviewed source and verify the intended runtime separately.
