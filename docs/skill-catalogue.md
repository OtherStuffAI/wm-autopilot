# Skill catalogue and project deployment

Autopilot owns a machine-local, owner-scoped Agent Skills catalogue at `/skills`. It imports Git/Forgejo or explicitly allowed local directories as immutable revisions, then projects selected revisions into known project folders.

## Safety model

- Import reads files but never executes repository hooks, installers, or skill scripts.
- Symlinks, traversal names, unsupported file types, and duplicate normalized skill names are rejected.
- Git imports disable hooks, pin the resolved commit, and snapshot validated content under Autopilot data storage.
- Deployment uses a staged copy and atomic rename. Existing unmanaged content is a conflict.
- Update and removal compare the current directory digest with recorded provenance. Locally modified content is not overwritten or deleted unless a new plan explicitly requests replacement.
- Mutation plans are owner-bound, exact-revision, one-use tokens that expire after ten minutes.

## Project layout and provenance

Portable copies are installed at `.agents/skills/<name>`. Project policy may also request a matching `.claude/skills/<name>` copy. `.agents/skills/.wingman-managed.json` records skill identity, revision, digest, and dates without credentials or catalogue cache paths. The SQLite deployment table is the reverse index.

Local-managed policy adds only generated paths to `.git/info/exclude`; repository-shared policy leaves them visible to Git. Detach retains project files and removes the management record. Remove deletes only matching managed content.

## Source lifecycle

Register a source, fetch to inspect its current commit/digest, import a validated immutable revision, then activate the import. Fetch/import/activate do not update projects. Plan and apply updates separately; bulk apply returns a result for every project.

Wingman sources can be marked default by an administrator. Reconciliation installs safe missing defaults for known projects. Per-project opt-outs are durable. Before a session starts, Autopilot safely reconciles defaults and records the exact current managed revisions in session metadata as `resolvedSkillRevisions`; conflicts and local modifications remain untouched.

## Operator checks

After deploying code, restart Autopilot from outside an active managed session. Then sign in, open `/skills`, import a test skill, register/select a project, preview and apply a deployment, and verify the manifest plus session metadata. No live restart is performed by repository validation.
