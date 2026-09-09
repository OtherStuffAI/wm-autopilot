FROM golang:1.25-trixie@sha256:2c4c60ef415fbfa5e90300722293bef36c5e63fae17570ce18f580af933dbd73 AS agentapi-builder
RUN git clone https://github.com/coder/agentapi.git /src/agentapi \
  && cd /src/agentapi && git checkout 9ff117e231822f670305254ef24f6389f75953f4
COPY vendor/agentapi/loopback-listener.patch /tmp/loopback-listener.patch
RUN cd /src/agentapi && git apply /tmp/loopback-listener.patch \
  && go build -trimpath -o /agentapi .

FROM oven/bun:1.3.0-debian@sha256:386b9fd0974a0ad7d33a45c1f2e2ee7159da3807023868d0feb8b427af76b34e
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN WINGMAN_SKIP_AGENTAPI_INSTALL=1 bun install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY config ./config
COPY vendor ./vendor
COPY --from=agentapi-builder /agentapi /app/out/agentapi
RUN chmod +x scripts/isolated-test/deterministic-acp.ts \
  && mkdir -p /app/data /app/tmp /workspace \
  && bun -e 'import { writeFile } from "node:fs/promises"; import { createAgentApiProvenance, getAgentApiProvenancePath } from "./src/server/bootstrap/agentapi-build.ts"; const p = "/app/out/agentapi"; await writeFile(getAgentApiProvenancePath(p), JSON.stringify(await createAgentApiProvenance(p, "/app")));' \
  && chown bun:bun /app /app/data /app/tmp /workspace
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV PORT=3600 WINGMAN_INSTANCE_NAME=isolated-release-test
USER bun
EXPOSE 3600
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 \
  CMD bun run scripts/isolated-test/api.ts --health
CMD ["bun", "run", "scripts/isolated-test/entrypoint.ts"]
