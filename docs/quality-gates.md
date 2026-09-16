# Quality Gates

Use these package scripts when validating Autopilot changes:

- `bun run lint` or `bun run lint:check` runs Biome linting over source, CLI, and script files. Formatting is disabled in this first pass to avoid broad historical churn.
- `bun run whitespace:check` runs `git diff --check` for unstaged and staged changes.
- `bun run maintainability:report` prints report-only large-file and large-function findings for tracked source files.
- `bun run validate` runs the first-pass gate: whitespace, typecheck, lint, tests, public-source quality, security audit, and maintainability reporting.

`validate` keeps historical-noise checks visible without making the gate unusable:

- Blocking: whitespace, typecheck, lint, tests, and security audit.
- Report-only: public-source quality and maintainability reporting.

`validate` stops at the first failed blocking check. Run later checks directly when collecting a full baseline after an earlier gate fails.

The maintainability report is intentionally nonblocking. Tune thresholds with:

```bash
MAINTAINABILITY_FILE_LINES=500 MAINTAINABILITY_FUNCTION_LINES=150 bun run maintainability:report
```

Promote checks from report-only to blocking only after the existing baseline has been reduced enough that failures point to new regressions.
