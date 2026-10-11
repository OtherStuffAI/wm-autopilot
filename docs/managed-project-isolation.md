# Managed project isolation

`runIsolatedProject` in `src/isolation/managed-project.ts` is an opt-in,
trusted control-plane primitive. Trusted sessions retain their current behavior.
The dedicated `isolated-codex` completed-turn runtime integrates separately with
FIFO receipts and private native snapshot bindings. Participant activation stays
gated until explicitly authorized live provider and hosted acceptance pass.
The focused suite covers actual native resume with synthetic inference separately
from synthetic continuity persistence.

## Boundary and limits

A fresh non-root Linux container receives only two validated file snapshots over
stdin: project source and private continuity. Nothing on the host is mounted.
Root filesystem is read-only; workspace, continuity and temp are bounded tmpfs.
The image must be an audited, immutable local SHA-256 ID containing only approved
runtime/tools and these workers. Do not use an application/service image, an
image with credentials, image-declared volumes or sensitive environment defaults.

Network is `none` (including direct provider and package downloads). An optional
loopback-only model gateway forwards validated requests over stdin/stdout to the
trusted host; it grants only inference for one fixed model. No broker credentials,
signing tools, manager environment, Docker socket, host home or sibling files are
provided. All Linux capabilities are dropped, privilege escalation is disabled,
and the runtime retains Docker's default seccomp. PID, IPC and cgroup namespaces
are private. Generated scripts inherit the same limits; shell execution never
falls back to the host.

| Resource | Limit per invocation |
| --- | --- |
| Memory / memory plus swap | 512 MiB / 512 MiB |
| CPU | 1 CPU |
| Processes | 128 |
| Workspace / continuity / temp | 64 / 32 / 16 MiB |
| Single file / open descriptors / core | 16 MiB / 256 / zero |
| Snapshot | 16 MiB decoded and 2048 files per tree |
| Command output | 64 KiB combined |
| Transport output / input | 48 / 80 MiB |
| Model calls | 8, each <=256 KiB request / 2 MiB reply / 4096 output tokens |
| Model call deadline | 30 seconds within the invocation deadline |
| Deadline | At most 120 seconds |

Host and container timers enforce the deadline. The host removes the entire
container on success, failure or timeout, including descendants. Cleanup failure
is surfaced. Docker control commands have a 10-second timeout. Operator loss of
the host and deliberate suspension of the container supervisor still require
external orphan reconciliation; do not treat this as a crash-proof scheduler.
Use a bounded global admission queue and serialize a project's mutations before
calling this API. No concurrency/cost scheduler is supplied by this primitive.

Snapshots support regular files with conservative relative paths and base64 data.
Links, special files, path traversal and file/directory conflicts are rejected.
Returned files, stdout and continuity remain untrusted: independently validate
assets before promotion, persist into the correct private binding, and never
execute returned content on the host. Snapshot export is not a tamper-proof
model receipt. Same-container descendants can mutate their own files; no host
file or authority is reachable through export. Failed runs return no snapshots.
Full package trees with symlinks and large native stores are intentionally unsupported.
Private continuity inputs must contain only conversation state, never auth.json,
provider keys, broker configuration or a copy of host home.

## Build and focused validation

```sh
docker build -f scripts/project-isolation/Dockerfile -t wm-project-isolation:v1 .
WINGMAN_ISOLATION_TEST_IMAGE="$(docker image inspect wm-project-isolation:v1 --format '{{.Id}}')" bun test src/isolation
bun run typecheck
git diff --check
```

The Dockerfile defaults to the pinned official Bun 1.3.0 Debian image. If registry
access is unavailable, an operator may supply `--build-arg ISOLATION_BASE=<audited
local runtime image>`; record its immutable ID and actual Bun version. Runtime
tests are explicitly skipped without `WINGMAN_ISOLATION_TEST_IMAGE`; skipped tests
never satisfy acceptance. The runtime suite exercises the production launcher,
synthetic host files, generated commands, process/network/capability denial,
actual cgroup/tmpfs limits, project edits, synthetic continuity rehydration,
timeout cleanup, unsafe links and output bounds. It never reads host credentials.

Docker Engine with Linux containers, default seccomp, cgroups and tmpfs support
is required. On macOS this uses Docker Desktop's Linux VM; sandbox-exec and cwd
are not substitutes. Docker authority belongs only to the trusted control plane.
Official runtime options and default seccomp behavior are documented at
https://docs.docker.com/engine/containers/run/ and
https://docs.docker.com/engine/security/seccomp/.

## Native runtime and activation

`runIsolatedCodex` uses a native Linux CLI inside this exact boundary, a private
`CODEX_HOME`, and an explicit native reference on resume. Prompts travel through
stdin so participant text cannot become CLI options. User config/rules and hosted
web search are disabled; the externally enforced container is the tool sandbox.
The gateway provides only `/v1/responses` on loopback. Model selection, remote
MCP/web tools, URLs and private response/conversation/file references are denied.
Upstream calls disable response storage and cap output. Credentials remain in a
trusted-host callback, never the snapshot, command arguments or worker environment.
`createResponsesProvider` uses a fixed HTTPS upstream and refuses redirects.

Prepare the public Codex 0.159.2 Linux arm64 npm archive (the preparation script
pins its SHA-512; partial/corrupt downloads fail). Binary inputs are ignored and
untracked; only an empty ignored build context is accepted:

```sh
curl --fail --location --max-time 1800 \
  https://registry.npmjs.org/@openai/codex/-/codex-0.159.2-linux-arm64.tgz \
  -o tmp/docs/handoffs/codex-native.tgz
bun scripts/project-isolation/prepare-codex.ts \
  tmp/docs/handoffs/codex-native.tgz tmp/docs/handoffs/codex-runtime
docker build -f scripts/project-isolation/Dockerfile.codex \
  --build-context codex-runtime=tmp/docs/handoffs/codex-runtime \
  -t wm-project-isolation-codex:v1 .
WINGMAN_ISOLATION_NATIVE_TEST_IMAGE="$(docker image inspect wm-project-isolation-codex:v1 --format '{{.Id}}')" \
WINGMAN_ISOLATION_TEST_IMAGE="$(docker image inspect wm-project-isolation-codex:v1 --format '{{.Id}}')" \
  bun test src/isolation
```

The native fixture test uses actual CLI JSON events, tool execution and private
state rehydration in fresh containers with synthetic inference. It also exercises
the generic completed-turn runtime across reopened SQLite state, same native
reference and duplicate-request recovery without resending. It does not prove
live provider authorization, real model generation or hosted pipeline delivery.
The current native binary recipe supports Linux arm64 only. Do not substitute a
macOS executable or label a newly created conversation as a resume.

The session runtime requires all three dedicated settings:
`WINGMAN_ISOLATED_CODEX_IMAGE` (audited immutable local image ID),
`WINGMAN_ISOLATED_CODEX_MODEL` (fixed authorized model), and
`WINGMAN_ISOLATED_CODEX_API_KEY` (dedicated authorized provider credential).
It never borrows `OPENAI_API_KEY`, `CODEX_API_KEY` or host CLI authentication.
Provision the provider grant in the trusted service environment using the
operator's approved secret mechanism; never retrieve or copy existing personal
or agent keys. Model credentials and app signing authority are separate grants.
Keep pipeline execution scoped to the authorized app definition and project.

No Autopilot restart is needed to build the images or run standalone tests.
Activating new platform source in the existing service requires explicit operator
approval. After activation, prove two real provider turns and stopped native
resume, rerun denials in that final image, and collect actual request/run/execution/
native-reference mappings with signed delivery receipts. Generation stays gated
until that acceptance passes. Safe progress is lifecycle status from the generic
operation; this transport buffers model SSE and supplies no native token stream.
