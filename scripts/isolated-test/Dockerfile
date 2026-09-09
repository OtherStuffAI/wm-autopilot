FROM node:22-trixie@sha256:97337fb5b20347953eb4b9aa0183c73259a0e21934b07845f04278e4954ae61a AS fips-downloader

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG FIPS_VERSION=0.5.0
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && BUILD_ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && case "${BUILD_ARCH}" in \
      amd64|x86_64) FIPS_ARCH=x86_64; FIPS_SHA256=a57240b70d8e0940ba5d962b0b9881cadd2befb43b75991e435d74243cbd7b27 ;; \
      arm64|aarch64) FIPS_ARCH=aarch64; FIPS_SHA256=c0e00bd8e9dc0ca01cbd6992da5d3944530a6a18df4e2d36c073b3913488d40f ;; \
      *) echo "Unsupported FIPS Docker target architecture: ${BUILD_ARCH}" >&2; exit 1 ;; \
    esac \
  && FIPS_ARCHIVE="fips-${FIPS_VERSION}-linux-${FIPS_ARCH}.tar.gz" \
  && curl -fsSL "https://github.com/jmcorgan/fips/releases/download/v${FIPS_VERSION}/${FIPS_ARCHIVE}" -o "/tmp/${FIPS_ARCHIVE}" \
  && echo "${FIPS_SHA256}  /tmp/${FIPS_ARCHIVE}" | sha256sum -c - \
  && mkdir -p /fips-release \
  && tar -xzf "/tmp/${FIPS_ARCHIVE}" -C /fips-release --strip-components=1 \
  && test -x /fips-release/fips \
  && test -x /fips-release/fipsctl \
  && test -f /fips-release/fips.nft

FROM golang:1.25-trixie@sha256:2c4c60ef415fbfa5e90300722293bef36c5e63fae17570ce18f580af933dbd73 AS agentapi-builder
RUN git clone https://github.com/coder/agentapi.git /src/agentapi \
  && cd /src/agentapi && git checkout 9ff117e231822f670305254ef24f6389f75953f4
COPY vendor/agentapi/loopback-listener.patch /tmp/loopback-listener.patch
RUN cd /src/agentapi && git apply /tmp/loopback-listener.patch \
  && go build -trimpath -o /agentapi .

FROM oven/bun:1.3.0-debian@sha256:386b9fd0974a0ad7d33a45c1f2e2ee7159da3807023868d0feb8b427af76b34e AS bun-runtime

FROM node:22-trixie@sha256:97337fb5b20347953eb4b9aa0183c73259a0e21934b07845f04278e4954ae61a
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN useradd --create-home --shell /bin/bash bun
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates iproute2 nftables tcpdump curl openssl bash \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN WINGMAN_SKIP_AGENTAPI_INSTALL=1 bun install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY scripts ./scripts
COPY clis ./clis
COPY public ./public
COPY config ./config
COPY vendor ./vendor
COPY --from=agentapi-builder /agentapi /app/out/agentapi
COPY --from=fips-downloader /fips-release/fips /usr/local/bin/fips
COPY --from=fips-downloader /fips-release/fipsctl /usr/local/bin/fipsctl
COPY --from=fips-downloader /fips-release/fips.nft /etc/fips/fips.nft
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
