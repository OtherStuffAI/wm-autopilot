FROM golang:1.25-trixie@sha256:2c4c60ef415fbfa5e90300722293bef36c5e63fae17570ce18f580af933dbd73 AS agentapi-builder

RUN git clone https://github.com/coder/agentapi.git /src/agentapi \
  && cd /src/agentapi \
  && git checkout 9ff117e231822f670305254ef24f6389f75953f4
COPY vendor/agentapi/loopback-listener.patch /tmp/loopback-listener.patch
RUN cd /src/agentapi \
  && git apply --check /tmp/loopback-listener.patch \
  && git apply /tmp/loopback-listener.patch \
  && go build -trimpath -o /agentapi .

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

FROM node:22-trixie@sha256:97337fb5b20347953eb4b9aa0183c73259a0e21934b07845f04278e4954ae61a

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG INSTALL_AGENT_CLIS=true
ARG CODEX_PACKAGE=@openai/codex@0.144.6
ARG CLAUDE_PACKAGE=@anthropic-ai/claude-code@2.1.241
ARG OPENCODE_PACKAGE=opencode-ai@1.18.21
ARG FLIGHTDECK_CLI_PACKAGE=@runwingman/flightdeck-cli@0.2.1
ARG GOOSE_VERSION=v1.33.1
ARG BUN_VERSION=1.4.0
ARG TARGETARCH

ENV BUN_INSTALL=/usr/local/bun \
  PATH=/usr/local/bun/bin:/usr/local/bin:/home/wingman/.local/bin:$PATH \
  HOME=/home/wingman \
  PORT=3600 \
  DIRECTORY_DEF=/workspace \
  FOLDERACCESS=/workspace \
  APP_ROUTING=path \
  AGENT_SPAWN_MODE=bun \
  AGENTAPI_ALLOWED_HOSTS=localhost,127.0.0.1,[::1] \
  CODEX_CLI=/usr/local/bin/codex \
  CODEX_TRUSTED_WORKSPACE=/workspace \
  CLAUDE_CLI=/usr/local/bin/claude \
  GLOVES=OFF \
  CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL=0 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  GOOSE_CLI=/usr/local/bin/goose \
  OPENCODE_CLI=/usr/local/bin/opencode \
  GEMINI_CLI=/usr/local/bin/gemini \
  PI_CLI=/usr/local/bin/pi \
  WINGMAN_SHARED_INSTANCE=true \
  WINGMAN_SETUP_NONINTERACTIVE=true \
  AGENT_CHAT_YOKE_HELPERS_PATH=/opt/flightdeck-cli/src/bot-helpers.js \
  AGENT_CHAT_YOKE_TRANSLATORS_PATH=/opt/flightdeck-cli/src/translators.js \
  AGENT_CHAT_YOKE_CLI_PATH=/opt/flightdeck-cli/src/cli.js \
  AGENT_CHAT_YOKE_CLIENT_PATH=/opt/flightdeck-cli/src/client.js \
  AGENT_CHAT_YOKE_WORKSPACE_KEYS_PATH=/opt/flightdeck-cli/src/workspace-keys.js \
  AGENT_CHAT_YOKE_NOSTR_PATH=/opt/flightdeck-cli/src/nostr.js

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    bzip2 \
    ca-certificates \
    coreutils \
    curl \
    file \
    findutils \
    g++ \
    gcc \
    git \
    gosu \
    jq \
    less \
    libdbus-1-3 \
    libvulkan1 \
    make \
    nftables \
    openssh-client \
    pkg-config \
    procps \
    python3 \
    tar \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN BUILD_ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
  && case "${BUILD_ARCH}" in \
      amd64|x86_64) BUN_ARCH=x64 ;; \
      arm64|aarch64) BUN_ARCH=aarch64 ;; \
      *) echo "Unsupported Docker target architecture: ${BUILD_ARCH}" >&2; exit 1 ;; \
    esac \
  && BUN_ARCHIVE="bun-linux-${BUN_ARCH}.zip" \
  && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ARCHIVE}" -o "/tmp/${BUN_ARCHIVE}" \
  && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt \
  && grep " ${BUN_ARCHIVE}$" /tmp/SHASUMS256.txt | (cd /tmp && sha256sum -c -) \
  && unzip -q "/tmp/${BUN_ARCHIVE}" -d /tmp/bun-release \
  && mkdir -p /usr/local/bun/bin \
  && install -m 0755 "/tmp/bun-release/bun-linux-${BUN_ARCH}/bun" /usr/local/bun/bin/bun \
  && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun \
  && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bunx \
  && rm -rf "/tmp/${BUN_ARCHIVE}" /tmp/SHASUMS256.txt /tmp/bun-release

RUN if [[ "${INSTALL_AGENT_CLIS}" == "true" ]]; then \
    bun install -g "${CODEX_PACKAGE}"; \
    ln -sf /usr/local/bun/bin/codex /usr/local/bin/codex; \
    npm install -g "${CLAUDE_PACKAGE}" "${OPENCODE_PACKAGE}"; \
    curl -fsSL "https://github.com/aaif-goose/goose/releases/download/${GOOSE_VERSION}/download_cli.sh" \
      | GOOSE_VERSION="${GOOSE_VERSION}" GOOSE_BIN_DIR=/usr/local/bin CONFIGURE=false bash; \
  fi

ARG GEMINI_PACKAGE=@google/gemini-cli@0.56.0
ARG PI_PACKAGE=@earendil-works/pi-coding-agent@0.84.2

RUN if [[ "${INSTALL_AGENT_CLIS}" == "true" ]]; then \
    npm install -g "${GEMINI_PACKAGE}" "${PI_PACKAGE}"; \
  fi

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "${FLIGHTDECK_CLI_PACKAGE}" \
  && FLIGHTDECK_CLI_ROOT="$(npm root -g)/@runwingman/flightdeck-cli" \
  && test -f "${FLIGHTDECK_CLI_ROOT}/src/cli.js" \
  && ln -sfn "${FLIGHTDECK_CLI_ROOT}" /opt/flightdeck-cli

RUN useradd --create-home --home-dir /home/wingman --shell /bin/bash --uid 10001 wingman \
  && groupadd --system fips \
  && usermod -aG fips wingman \
  && mkdir -p /app/data /app/tmp /app/out /etc/fips/fips.d \
  && chown -R wingman:wingman \
    /app \
    /home/wingman \
    /usr/local/bin \
    /usr/local/bun \
    /usr/local/lib/node_modules

WORKDIR /app

COPY --chown=wingman:wingman package.json bun.lock bunfig.toml ./
COPY --chown=wingman:wingman scripts/install-agentapi-loopback.ts ./scripts/
RUN WINGMAN_SKIP_AGENTAPI_INSTALL=1 bun install --frozen-lockfile \
  && chown -R wingman:wingman /app/node_modules /usr/local/bun

COPY --chown=wingman:wingman . .
COPY --from=agentapi-builder --chown=wingman:wingman /agentapi /app/out/agentapi
COPY --from=fips-downloader /fips-release/fips /usr/local/bin/fips
COPY --from=fips-downloader /fips-release/fipsctl /usr/local/bin/fipsctl
COPY --from=fips-downloader /fips-release/fips.nft /etc/fips/fips.nft
RUN bun build --compile --minify src/git/git-credential-wingman.ts --outfile /usr/local/bin/git-credential-wingman \
  && test -x /usr/local/bin/git-credential-wingman \
  && chmod +x scripts/docker-entrypoint.sh \
  && bun -e "import { writeFile } from 'node:fs/promises'; import { createAgentApiProvenance, getAgentApiProvenancePath } from './src/server/bootstrap/agentapi-build.ts'; const binaryPath = '/app/out/agentapi'; const provenance = await createAgentApiProvenance(binaryPath, '/app'); await writeFile(getAgentApiProvenancePath(binaryPath), JSON.stringify(provenance, null, 2) + '\\n');"

EXPOSE 3600

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD bun run scripts/docker-readiness.ts --strict --json >/dev/null

CMD ["scripts/docker-entrypoint.sh", "bun", "start"]
