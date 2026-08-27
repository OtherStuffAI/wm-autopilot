# Artifact WApp iframe security regression

## Goal

Restore same-origin embedded artifact/whiteboard frames in Rick's managed Artifact WApp without weakening Autopilot's control-plane clickjacking protection.

Flight Deck task: `Restore Artifact WApp whiteboards and consolidate Wingman Suite artifacts` (`95951211-8547-4f74-9db7-4c8125fdb8e3`). Originating message: `a611a0c6-cb8e-44a1-83d9-f7bf68b3f168` in channel `aa17d938-ce69-4563-a5bf-72e6b2bc8491`, thread `1829ab38-aa06-4d35-8aac-9a1123549c1e`.

## Confirmed reproduction and diagnosis

Pete's Firefox screenshot is storage object `eaedc75b-1adb-484e-8727-37959160e19a`. It shows the WApp shell at:

`https://pale-log-tank.rick.runwingman.com/artifacts/Wingman_Suite/wingman-suite-arch/v4/`

The shell loads, but Firefox replaces the inner artifact frame with “Firefox Can’t Open This Page” because the response refuses embedding.

Live header evidence on 2026-08-27:

```text
GET /artifacts/Wingman_Suite/wingman-suite-arch/v4/
X-Frame-Options: DENY

GET /artifact-frame/Wingman_Suite/wingman-suite-arch/v4/index.html
X-Frame-Options: DENY
```

Current `src/server.ts` calls `applySecurityHeaders(response)` after all routing, including `handleAppHostRequest(...)`. `applySecurityHeaders` unconditionally overwrites `X-Frame-Options` with `DENY`, although its comment says it protects control-plane responses. Artifact WApp deliberately embeds a same-origin `/artifact-frame/...` URL inside its shell, so `DENY` blocks intended behavior.

This appeared after the 2026-08-24 public Autopilot baseline introduced the global header.

## Required implementation

- Separate security-header policy for Autopilot control-plane responses from managed-app proxy responses.
- Keep `X-Frame-Options: DENY` (or an equally strict explicit policy) for Autopilot control-plane/UI/API responses.
- For managed-app responses, allow the app's own clickjacking/frame policy to survive. When the upstream app provides no policy, use a safe default that still permits same-origin framing, such as `X-Frame-Options: SAMEORIGIN` and/or an equivalent `frame-ancestors 'self'` policy if compatible with the existing response CSP.
- Do not blindly overwrite an app-provided stricter or intentionally broader policy; document the precedence.
- Cover both hostname/subdomain app proxying and `/host/<alias>` path-based proxying if both pass through the same global middleware.
- Keep the other global browser headers (`nosniff`, referrer policy, permissions policy) unless investigation proves a route-specific incompatibility.
- Add focused regression tests demonstrating:
  - control-plane responses remain `DENY`;
  - a managed app with no frame header is same-origin embeddable but not openly frameable;
  - an upstream managed app's explicit frame policy is preserved;
  - both proxy forms behave consistently where supported.

## Architecture and constraints

The latest living Wingman Suite architecture is `Wingman_Suite/wingman-suite-arch/v4`. It keeps Autopilot responsible for managed apps/runtime and WApps responsible for their UI. The fix therefore belongs at the Autopilot proxy/header boundary, not as a browser workaround inside Artifact WApp.

- Work on `main` in `/Users/mini/code/wm/autopilot`.
- Preserve concurrent work. The repo is currently clean and one commit ahead of `origin/main`; do not rebase, reset, or drop that commit.
- Run the narrowest relevant tests, then `bun test` and `bun run typecheck` if feasible.
- Commit the complete tested nonignored worktree state using a Conventional Commit.
- Do not push, deploy, or restart Autopilot. The running process must not be disrupted without Pete's explicit approval.

## Reporting

Return the root cause, policy chosen, files changed, exact tests/results, commit hash, and whether the running service will require an approved restart before Pete can verify the live URL. Do not post to Flight Deck directly; Rick will update the task and originating thread.

## Implemented policy

Autopilot now selects browser security headers at the response boundary:

- Control-plane UI and API responses always receive `X-Frame-Options: DENY`, overriding any route-level value.
- Managed-app responses preserve a non-empty upstream `X-Frame-Options` value.
- If no `X-Frame-Options` value exists, an upstream enforcing CSP `frame-ancestors` directive remains authoritative and no competing frame header is added.
- If the managed app supplies neither policy, Autopilot adds `X-Frame-Options: SAMEORIGIN`.
- `nosniff`, the referrer policy, and the permissions policy continue to apply to both boundaries.

Hostname/custom-domain app routing and `/host/<alias>` path routing both explicitly mark their responses as managed-app responses before the final middleware runs.
