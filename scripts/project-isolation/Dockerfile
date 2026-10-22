ARG ISOLATION_BASE=oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e
FROM ${ISOLATION_BASE}
COPY src/isolation/project-profile.ts src/isolation/container-worker.ts src/isolation/container-gateway.ts src/isolation/provider-policy.ts src/isolation/json-lines.ts src/isolation/native-codex.ts src/isolation/native-codex-command.ts /opt/isolation/
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/bun", "/opt/isolation/container-worker.ts"]
