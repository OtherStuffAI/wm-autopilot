import { contextCliHelp } from "./context-cli.ts";

export function usageText(): string {
  return `${contextCliHelp}

Wingman Flight Deck PG CLI

Usage:
  bun clis/wingman.ts flightdeck context --json
  bun clis/wingman.ts flightdeck status --json
  bun clis/wingman.ts flightdeck workspaces list --json
  bun clis/wingman.ts flightdeck tasks list --workspace <workspace-id> --channel <channel-id> [--cursor <opaque-cursor>] [--limit 100] --json
  bun clis/wingman.ts flightdeck task show <task-id> --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck task comment <task-id> --workspace <workspace-id> --body "..." --json
  bun clis/wingman.ts flightdeck task state <task-id> --workspace <workspace-id> --state in_progress --json
  bun clis/wingman.ts flightdeck task move <task-id> --workspace <workspace-id> --destination-channel <channel-id> [--destination-scope <scope-id>] --json
  bun clis/wingman.ts flightdeck thread read <thread-id> --workspace <workspace-id> --channel <channel-id> [--limit <page-size>] --json
    Reads all effective transcript pages; --limit is page size (1–500, default 200), not a total cap.
  bun clis/wingman.ts flightdeck task comments <task-id> --workspace <workspace-id> [--cursor <cursor>] [--all] --json
  bun clis/wingman.ts flightdeck doc comments <doc-id> --workspace <workspace-id> [--cursor <cursor>] [--all] --json
    Single-page output explicitly reports partial/complete. --all fails on repeated rows/cursors.
  bun clis/wingman.ts flightdeck thread create --workspace <workspace-id> --channel <channel-id> --body "..." --json
  bun clis/wingman.ts flightdeck thread rename <thread-id> --workspace <workspace-id> --title "..." --json
  bun clis/wingman.ts flightdeck file download <file-id> --workspace <workspace-id> --out ./file.bin --json
    Verifies size and SHA-256; refuses to overwrite existing output.
  bun clis/wingman.ts flightdeck chat reply --workspace <workspace-id> --channel <channel-id> --thread <thread-id> --body "..." --json
    Chat replies and task/document comments accept --mentions-json '[{"type":"agent","npub":"npub1…","label":"Name"}]' (visible canonical tags are added from the same entries).
  bun clis/wingman.ts flightdeck doc create --workspace <workspace-id> --channel <channel-id> --title "..." --body-file file.md --json
  bun clis/wingman.ts flightdeck doc download <doc-ref> --workspace <workspace-id> --out ./tmp/design.md --json
  bun clis/wingman.ts flightdeck doc move <doc-id> --workspace <workspace-id> --destination-channel <channel-id> [--destination-scope <scope-id>] --json
  bun clis/wingman.ts flightdeck attachment blossom <storage-id> --message <message-id> --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck attachment publish <storage-id> --message <message-id> --public --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck attachment unpublish <storage-id> --message <message-id> --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck file blossom <file-id> --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck file publish <file-id> --version <version-id> --public --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck file unpublish <file-id> --version <version-id> --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck file upload --workspace <workspace-id> --channel <channel-id> --path ./artifact.png --json
  bun clis/wingman.ts flightdeck workroom show <workroom-id> --workspace <workspace-id> --json
  bun clis/wingman.ts flightdeck workroom event <workroom-id> --workspace <workspace-id> --type pr_ready --title "PR ready" --json
  bun clis/wingman.ts flightdeck workroom link <workroom-id> --workspace <workspace-id> --link-type pull_request --target-type pull_request --external-url https://github.com/org/repo/pull/1 --json
  bun clis/wingman.ts flightdeck workroom approval-request <workroom-id> --workspace <workspace-id> --repo org/repo --to-branch deployed --commit abc123 --json

Agent sessions automatically use the capability broker and hydrate omitted
Tower, app, workspace, channel, thread, task, and scope values from dispatch
context. Use --bot-crypto to require broker mode explicitly. --key and
WINGMAN_NSEC are operator-only.`;
}
