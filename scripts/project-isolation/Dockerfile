ARG ISOLATION_BASE=oven/bun:1.3.0-debian@sha256:386b9fd0974a0ad7d33a45c1f2e2ee7159da3807023868d0feb8b427af76b34e
FROM ${ISOLATION_BASE}
COPY src/isolation/project-profile.ts src/isolation/container-worker.ts src/isolation/container-gateway.ts src/isolation/provider-policy.ts src/isolation/json-lines.ts src/isolation/native-codex.ts src/isolation/native-codex-command.ts /opt/isolation/
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/bun", "/opt/isolation/container-worker.ts"]
