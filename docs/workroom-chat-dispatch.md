# Typed workroom chat dispatch

Autopilot asks Tower for typed context before starting a Flight Deck chat pipeline:

`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/workroom-context?channel_id=:channelId&thread_id=:threadId&actor_npub=:actorNpub`

The request uses the existing bot NIP-98 credential and `x-flightdeck-pg-app-npub`. Tower returns `{ "isWorkroom": false }` for ordinary threads. A missing route (`404`, `405`, or `501`) is treated as that normal-thread response so Autopilot remains compatible while the Tower worker lands the endpoint; other errors fail dispatch visibly.

For a workroom, Tower returns typed room, participant role/metadata, repository and branches, app targets with runbooks, recent events/links, and open approvals. The dispatch envelope exposes this as `workroomContext` and the intent packet includes it only when `isWorkroom` is true.

Participant self-fill uses the structured metadata endpoint:

`PATCH /api/v4/flightdeck-pg/workspaces/:workspaceId/workrooms/:workroomId/participant`

with `{ "metadata": { "repoPath", "defaultBranch", "capabilities", "localApps", "constraints", "canRunTests" } }`. The `workroom.prepareParticipantMetadata` function produces this typed payload without prose; the Tower patch client is available for the pipeline publisher when the companion route is deployed.
