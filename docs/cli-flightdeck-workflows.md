# Maintained Flight Deck CLI workflows

Run `bun clis/wingman.ts flightdeck help` from the active Autopilot checkout.
Agent sessions use the capability broker automatically; `--bot-crypto` requires
it explicitly. Keep explicit `--workspace` on cross-workspace commands. Tower
remains responsible for record ACLs; selecting a workspace grants no access.
Unknown options, unsupported command options and surplus positionals fail before
requests. Boolean switches can precede command words.

## Complete comments and exports

```sh
bun clis/wingman.ts flightdeck task comments <task-id> --workspace <workspace-id> --all --limit 100 --json
bun clis/wingman.ts flightdeck doc comments <doc-id> --workspace <workspace-id> --all --json
bun clis/wingman.ts flightdeck doc download <doc-id> --workspace <workspace-id> --out ./report.md --json
```

Without `--all`, comment commands return one page, including `next_cursor`,
`partial` and `complete`. Pass `--cursor <opaque-cursor>` to continue manually;
a resumed range is not the complete history. With `--all`, `--limit` is the page
size. Exports retrieve every comments page. Invalid pagination envelopes,
repeated rows/cursors, missing terminal cursors and failed later requests are
errors; an incomplete comment export is not reported as success.

Tower must preserve the timestamp cursor's microseconds through its database
driver. Enlarging `--limit` is a bounded recovery technique for a known record,
not a repair for repeated-page behavior. Activate the Tower timestamp-binding
repair before treating a complete live traversal as verified.

## Routed actor mentions

```sh
bun clis/wingman.ts flightdeck chat reply --workspace <workspace-id> --channel <channel-id> --thread <thread-id> --body "Please review" --mentions-json '[{"type":"agent","npub":"<full-agent-npub>","label":"Reviewer"}]' --json
bun clis/wingman.ts flightdeck task comment <task-id> --workspace <workspace-id> --body "Please review" --mentions-json '[{"type":"agent","npub":"<full-agent-npub>","label":"Reviewer"}]' --json
bun clis/wingman.ts flightdeck doc reply <doc-id> --comment <comment-id> --workspace <workspace-id> --body "Please review" --mentions-json '[{"type":"agent","npub":"<full-agent-npub>","label":"Reviewer"}]' --json
```

The same entry supplies the visible canonical tag and structured routing list in
operator, ordinary broker, strict-inbox and cross-workspace modes. Person mentions
use `type: "person"`. Labels and npubs are validated by the shared mention parser.
A visible tag without a matching structured entry fails at the CLI boundary.
Strict-inbox writes retain the Autopilot helper's provenance and Tower's inbox
security; ordinary writes retain the signed message protocol. The document-reply
helper fix requires Autopilot activation before that server path is live.

## New threads, titles and local files

```sh
bun clis/wingman.ts flightdeck thread create --workspace <workspace-id> --channel <channel-id> --body "New topic" --json
bun clis/wingman.ts flightdeck thread rename <thread-id> --workspace <workspace-id> --title "Reviewed topic" --json
bun clis/wingman.ts flightdeck file download <file-id> --workspace <workspace-id> --out ./attachment.bin --json
```

`chat create` is an alias for `thread create`. Creation uses the signed channel
message route. Rename reads the row version, sends it with the title update and
checks the saved title/version by reading back; conflicts are surfaced without
retry. Bots still need thread participation and channel write permission.

File download uses the ACL-checked typed file object route and verifies decoded
bytes against its size and SHA-256. It never forwards authentication to a URL
from metadata. Output is explicit and existing files are not overwritten. This
command currently transfers the complete object as base64 JSON, so allow memory
for both the envelope and decoded file.

## Create, read and safely edit documents

```sh
bun clis/wingman.ts flightdeck doc create --workspace <workspace-id> --channel <channel-id> --title "Plan" --body-file ./plan.md --json
bun clis/wingman.ts flightdeck doc show <doc-id> --workspace <workspace-id> --body --json
bun clis/wingman.ts flightdeck doc update <doc-id> --workspace <workspace-id> --body-file ./edited-plan.md --base-row-version <captured-row-version> --base-version-id <captured-version-id> --base-body-sha256-hex <captured-sha256> --json
```

Author the edit from the `doc show --body`/`doc_get` result and retain its
`captured_base`. The body response includes Tower's canonical version matching
that row and body storage object. Do not invent a base, relabel an old draft with
a new base, or bypass the edit lease. Missing canonical information is an
activation/contract problem. Concurrent edits and recovery responses remain
visible to the caller. A newer current metadata read does not replace the
captured draft base.

## Retire old workaround commands

| Previous workaround | Maintained replacement |
| --- | --- |
| Raw-key task creation helper or instructions saying task creation is absent | `flightdeck task create --channel ... --title ... --body ...` |
| Legacy `mycode/flightdeck-create-doc.mjs` importing an old checkout | `flightdeck doc create` / broker-aware document tools |
| `flightdeck-capability-chat-new-thread.mjs` | `flightdeck thread create` |
| `flightdeck-capability-rename-thread.mjs` | `flightdeck thread rename` with version/readback |
| Ad hoc signed file object/content export | `flightdeck file download` |
| One comments page or a larger-limit-only export | `task/doc comments --all`, `doc download` |
| Visible mention tags alone | `--mentions-json` plus the derived visible tags |

Retire a helper only after its replacement passes the needed live workflow on
the active runtime. Keep advanced API helpers for operations the CLI does not
expose. Do not revive raw keys, superseded checkouts or unsigned requests when a
broker denies an operation. These commands do not imply service restart or
deployment authority.
