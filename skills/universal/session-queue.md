---
description: Consume incorporated session instructions and distinguish fresh human turns from old callbacks
---

# Session queue pickup

Use supported broker-backed commands from the active Autopilot checkout:

```sh
bun clis/wingman.ts session queue list
bun clis/wingman.ts session queue consume <exact-item-id> \
  --revision <revision-actually-read> --reason "Incorporated this steering into current work"
```

Listing is inspection. Once you incorporate an instruction, consume that exact item immediately so it leaves pending and cannot reinforce/replay. Consumption records incorporation; it does not claim the entire task is complete. Do not acknowledge an item just because you listed it. Preserve unincorporated items. A changed revision or claimed delivery conflicts: inspect it rather than refreshing the revision merely to bypass the guard. Ordinary accepted dispatch consumes its own exact claim automatically.

Use only this session's capability. Do not substitute sessions, export keys, use raw-key requests, or edit runtime databases. Older live versions may lack `consume`; report pending activation rather than bypassing access controls. Uncertain transport is not rejection and never authorises automatic replay.

For a new human trigger that starts/resumes an inactive session, Autopilot retires old queued work, arrived callback notifications and obsolete wakes/publication observers before delivery. Pete explicitly accepts dropping interrupted queued work at this boundary (2026-10-15). History remains available. Start from the fresh question; inspect the thread and code for context. Do not answer it solely with an old callback acknowledgement or treat superseded worker work as verified successful. New callbacks remain independent arrivals. Workers are not cancelled just to clear notifications.

Use `bun clis/wingman.ts dispatch inbox` for fresh supervised results. Review evidence before acknowledging/closing a callback. Callback review does not replace the substantive answer to the current human message. See `docs/session-prompt-queue.md` for the lifecycle and exact-claim contract.
