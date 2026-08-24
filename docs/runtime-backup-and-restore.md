# Autopilot runtime backup and restore

Autopilot backups are encrypted at creation. The tool never emits an unencrypted archive and never exports environment variables, raw signing keys, legacy `apps.json`, logs, or the broker vault wrapping key.

It captures live SQLite databases using SQLite's online backup API, safe registry metadata, capability-broker metadata, and encrypted broker vault envelopes. Upload bodies are opt-in. The manifest records SHA-256 checksums, byte sizes, exclusions, and creation time.

## Prerequisites

Install [`age`](https://age-encryption.org/) and keep the identity file outside the Autopilot checkout. Use an explicit recipient; do not pass a secret identity as the recipient.

```bash
age-keygen -o /secure/offline/autopilot-backup.agekey
age-keygen -y /secure/offline/autopilot-backup.agekey
```

Store the identity in the operator's secret manager and keep an offline recovery copy. The broker wrapping/master key requires its own custody and recovery procedure; envelopes alone cannot restore signing.

## Create

Review the file-level plan first. This reads file metadata only; it does not open database rows or produce a backup:

```bash
bun scripts/runtime-backup.ts plan
```

```bash
bun scripts/runtime-backup.ts create \
  --recipient 'age1...' \
  --output /secure/backups/autopilot-$(date +%Y%m%dT%H%M%S).tar.age
```

Add `--include-uploads` only when file and audio bodies must be captured. Use `--uploads-dir` or `--data-dir` for a non-default runtime layout. Existing output files are never overwritten.

## Verify without restoring

```bash
bun scripts/runtime-backup.ts verify \
  --identity /secure/offline/autopilot-backup.agekey \
  /secure/backups/autopilot-20260814T120000.tar.age
```

Verification decrypts into a new temporary directory, validates every checksum, runs SQLite `quick_check`, and removes the temporary files. It does not open message rows or modify live state.

## Restore rehearsal

Restore is deliberately restricted to a new disposable directory under the operating-system temporary directory. It cannot target the live `data/` directory or merge with an existing directory.

```bash
bun scripts/runtime-backup.ts restore \
  --identity /secure/offline/autopilot-backup.agekey \
  /secure/backups/autopilot-20260814T120000.tar.age \
  --target /tmp/autopilot-restore-rehearsal-20260814
```

After rehearsal, inspect only operational integrity and counts. Promoting a rehearsal into a live runtime is a separate, operator-controlled maintenance procedure requiring Autopilot shutdown, an additional live backup, explicit broker wrapping-key recovery, and atomic directory replacement.

## Retention

Keep at least seven daily, five weekly, and twelve monthly encrypted backups, plus an offline copy. Verify a recent backup weekly and rehearse restoration quarterly. Apply retention only to completed `.age` files after verification; never delete live databases or the newest known-good backup from this tool.
