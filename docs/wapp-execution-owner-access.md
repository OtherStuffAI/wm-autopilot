# Installed app execution access

A managed WApp continues to sign requests as its installed app identity. Pipeline ownership, native binding keys, completed-turn idempotency and old evidence remain under that identity. The active installation registry supplies the owner/operator relationship for ordinary Autopilot run and session access. No human-signed token or record ownership migration is needed.

The installation owner (or a caller legitimately delegated into that owner space) can list and inspect the app's actual pipeline runs, steps and signed delivery state, and use ordinary authorized run/session controls. The owner's session filter includes installed app execution while the actual app owner remains visible in the record. Run summaries query only that owner's and installed app identities; this does not grant a global unfiltered list. Session list, messages, lifecycle and archive routes use the same installation relationship.

Only active installations with one unambiguous owner grant inherited access. Another owner, an archived/deleted installation, a conflicting ownership relationship or caller-supplied operator metadata does not. Existing shared-instance/admin rules remain independent. App-grant polling still requires the exact grant/run binding; owner access does not widen the app's credential authority.

Definitions stay in the installation owner's existing namespace and remain editable through the standard versioned definition UI. Exact-definition/function hash grants deliberately reject drift; after an authorized edit register a new exact grant and update the app configuration. Keep old grants for evidence/recovery. The native session and run record are the real execution, not a synthetic visibility copy.
