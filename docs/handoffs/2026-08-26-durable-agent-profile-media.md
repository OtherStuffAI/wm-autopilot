# Durable agent profile media

## Goal

Make Autopilot-managed agent profile pictures durable and self-owned instead of publishing a Nostr kind-0 event that points only at an external image URL. Keep the existing URL field as a compatibility path, but add an owned upload path that stores the selected image locally and publishes a stable public URL for the immutable local object.

This is a follow-up to Flight Deck task `752d5bcf-0af3-490e-a8f1-03d0b40c9556` and the agent-direct thread rooted at message `4e6523e3-8a85-4f3e-9142-f40cdb6d1058`. Pete's latest follow-up is message `1811a71b-fc13-4e4d-9444-1532a3a1fb20`.

## Confirmed failure

- Rick's active identity is `npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr` (`ffdc30446bede234446a69124bae94cdbddebf24f0abee4a5cabfc1124313c2e`).
- The latest kind-0 profile is published and currently contains:
  `https://cdn.satellite.earth/bef374b3eaca0c466e0d424e720b0513ef42c500c25cc6ef91324fa87ea93138.png`
- The latest relay event seen during this investigation is `aa0ec2959b4d4a003a7d87aa093849fcec6cfa3267627742c6f8e753a82777b5`, dated 2026-08-13T12:13:36Z.
- The Satellite origin times out at TCP connect. Flight Deck now correctly renders initials when the URL fails, but that only protects layout.
- `data/wingman.db.agent_definitions.public_profile_json` contains the same URL. There is no stored image object associated with it. The current editor accepts only `Public picture URL`, and profile publication signs/publishes the URL string.
- The image bytes are recoverable from Primal's cache. The exact original bytes were fetched from:
  `https://r2.primal.net/cache/4/d0/20/4d0205bb7aad681a27d6e26ad47cec4cf0b24222285273377fb9e9c0ecdc25cd.jpg`
  They are a 1024x1024 JPEG and their SHA-256 is exactly `bef374b3eaca0c466e0d424e720b0513ef42c500c25cc6ef91324fa87ea93138`.
- Do not add Rick-specific source rewriting or depend on Primal's cache for the generic product fix.

## Architecture boundary

Read the latest Wingman Suite architecture artifact before implementation:

`/Users/mini/code/wingmanbefree/artifact-wapp/artifacts/Wingman_Suite/wingman-suite-arch/v4/excalidraw-scene.json`

The current board keeps agent identity/runtime ownership in Autopilot and treats external Nostr profile lookup plus uploads/downloads as command concerns, separate from Flight Deck workspace sync. This task should stay in `/Users/mini/code/wm/autopilot` unless live code proves a Tower contract is required. Flight Deck's failure fallback is already implemented in commit `eacaf827a257de38190300e432debe19206bd402` and should not be reverted.

## Required implementation

1. Add an image-file selection path to the create/edit Agent Profile UI while retaining the explicit URL field for compatibility.
2. Add an authenticated profile-media upload path in Autopilot. Validate the actual file bytes, allow a narrow raster image set, reject SVG/HTML and mismatched/unsafe content, enforce a conservative size limit, and never trust the client filename for a filesystem path.
3. Store accepted bytes content-addressed under Autopilot's durable data directory, outside git, so the source survives browser caches and external-host loss. The stored object metadata must retain its verified content type, size, digest, creation time, and owning agent/profile identity.
4. Serve the immutable object through a narrowly scoped unauthenticated GET/HEAD route because a Nostr kind-0 `picture` must be fetchable by ordinary clients. Build the published URL from the configured external `WINGMAN_BASE_URL`; never publish localhost, a request Host header, an authenticated API URL, or an unconfigured/inaccessible placeholder.
5. Use hash-based routing, strict path validation, `X-Content-Type-Options: nosniff`, the verified media type, immutable caching, and tests for traversal, unknown hashes, unsupported media, MIME mismatch, oversize input, and unauthorized mutation.
6. On successful upload, update the candidate public profile with the owned public URL and publish the fresh kind-0 using the existing stable agent signing flow. Failure must be atomic from the user's perspective: do not replace the stored profile URL or report successful publication when upload/storage/public URL validation or relay publication fails.
7. Show an image preview and clear status in the editor. The user must be able to distinguish `saved locally`, `published to relays`, and failure. Do not claim an arbitrary URL was saved locally.
8. Add a safe operator/API path to import an already recovered local image for an existing profile. It must use the same validation/storage/publication pipeline as the UI; do not add a Rick-only migration or run the live mutation as part of automated tests.

## Current Rick repair (after code review and runtime approval)

The generic implementation must make it possible to import the recovered exact bytes, preserve them in Autopilot's local media store, and republish Rick's kind-0 to the resulting `WINGMAN_BASE_URL` media URL. Do not restart Autopilot or mutate Rick's live profile in this worker unless Pete explicitly approves those runtime actions in the originating conversation. Report the exact command/UI action that will perform the repair after the code is live.

## Validation and delivery

- Work on `main` in `/Users/mini/code/wm/autopilot`.
- Preserve concurrent work. Before commit, inspect the entire worktree and include all nonignored tested state unless there is a concrete safety conflict.
- Add focused route/storage/UI/publication tests and run the relevant broader Autopilot suite.
- Run `git diff --check` and the repo's normal build/type/test checks appropriate to the changed surfaces.
- Commit with a Conventional Commit message.
- No push, deploy, managed-process restart, or live profile publication.
- Report diagnosis, architecture choice, files changed, validation evidence, commit, and the exact post-restart repair step to Rick through the supervised callback. Do not post directly to Flight Deck; Rick owns task/thread updates.
