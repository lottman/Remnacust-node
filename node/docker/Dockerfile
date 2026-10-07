# BuildKit is required for cache mounts.

FROM node:24.21-trixie-slim AS build

WORKDIR /opt/app

COPY package*.json ./
RUN npm ci --prefer-offline --no-audit --no-fund

COPY . .

RUN npm run build \
    && npm run trace \
    && find dist/node_modules/@lmdb -name '*.node' ! -name 'node.napi.glibc.node' -delete \
    && ARCH=$([ "$(uname -m)" = aarch64 ] && echo linux-arm64 || echo linux-x64) \
    && find dist/node_modules/nftables-napi/prebuilds -name '*.musl.node' -delete \
    && find dist/node_modules/nftables-napi/prebuilds -mindepth 1 -maxdepth 1 -type d ! -name "$ARCH" -exec rm -rf {} + \
    && chmod +x dist/cli.js


FROM golang:1.27-alpine AS xray-device-build

ARG XRAY_CORE_VERSION=v26.9.30
ARG XRAY_CORE_COMMIT=b26a91de4f3294e26a0ad0a970b81a386a41f789
RUN apk add --no-cache git
COPY docker/remnacust-core.tar.gz docker/remnacust-core.tar.gz.sha256 /tmp/
RUN cd /tmp && sha256sum -c remnacust-core.tar.gz.sha256 \
    && mkdir -p /src && tar -xzf remnacust-core.tar.gz -C /src \
    && cd /src && sha256sum -c core-source.sha256 \
    && test "$(sed -n 's/.*"upstreamCommit": "\([^"]*\)".*/\1/p' core-source-lock.json)" = "${XRAY_CORE_COMMIT}"
WORKDIR /src/Xray-core-main
RUN go test ./infra/conf ./transport/internet/xerahttp ./app/dispatcher ./app/proxyman/command ./app/commander \
    && CGO_ENABLED=0 go build -trimpath -ldflags '-s -w -X github.com/xtls/xray-core/core.build=Remnacust-1.1.1' -o /tmp/xray ./main


FROM alpine:3.21 AS xray

ARG XRAY_CORE_VERSION=v26.9.30
ARG UPSTREAM_REPO=XTLS
ARG TARGETARCH

RUN apk add --no-cache curl \
    && case "${TARGETARCH:-$(uname -m)}" in \
        amd64|x86_64) ARCHIVE='Xray-linux-64.zip' ;; \
        arm64|aarch64) ARCHIVE='Xray-linux-arm64-v8a.zip' ;; \
        *) echo 'Unsupported Xray architecture' >&2; exit 1 ;; \
    esac \
    && BASE="https://github.com/${UPSTREAM_REPO}/Xray-core/releases/download/${XRAY_CORE_VERSION}" \
    && curl -fsSL -o "/tmp/${ARCHIVE}" "${BASE}/${ARCHIVE}" \
    && curl -fsSL -o /tmp/xray.dgst "${BASE}/${ARCHIVE}.dgst" \
    && echo "$(awk '/^SHA2-256=/ { print $2 }' /tmp/xray.dgst)  /tmp/${ARCHIVE}" | sha256sum -c - \
    && unzip -q "/tmp/${ARCHIVE}" -d /tmp/xray \
    && install -m 755 /tmp/xray/xray /usr/local/bin/xray \
    && install -d /usr/local/share/xray \
    && install -m 644 /tmp/xray/geoip.dat /usr/local/share/xray/geoip.dat \
    && install -m 644 /tmp/xray/geosite.dat /usr/local/share/xray/geosite.dat \
    && rm -rf "/tmp/${ARCHIVE}" /tmp/xray /tmp/xray.dgst


FROM alpine:3.21 AS asn

ARG ASN_LMDB_URL=https://github.com/remnawave/asn-index/releases/latest/download/asn-prefixes.lmdb.zst

RUN apk add --no-cache zstd curl

RUN curl --fail --location --retry 5 --retry-all-errors "${ASN_LMDB_URL}" \
    --output /tmp/asn-prefixes.lmdb.zst

RUN mkdir -p /usr/local/share/asn \
    && zstd -d /tmp/asn-prefixes.lmdb.zst -o /usr/local/share/asn/asn-prefixes.lmdb \
    && chmod 644 /usr/local/share/asn/asn-prefixes.lmdb \
    && rm -f /tmp/asn-prefixes.lmdb.zst


FROM golang:1.27-alpine AS geocheck
ARG GEOCHECK_VERSION=0.3.0
ARG GEOCHECK_COMMIT=50e084bb3ed34b55fc6839fe0dc4bafd9fe275fc
RUN apk add --no-cache git
WORKDIR /src/geocheck
RUN git init . \
    && git remote add origin https://github.com/remnawave/geocheck.git \
    && git fetch --depth 1 origin "${GEOCHECK_COMMIT}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${GEOCHECK_COMMIT}" \
    && go test -timeout 120s ./... \
    && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X github.com/remnawave/geocheck/internal/version.Version=${GEOCHECK_VERSION} -X github.com/remnawave/geocheck/internal/version.Commit=${GEOCHECK_COMMIT}" -o /usr/local/bin/geocheck ./cmd/geocheck


FROM scratch AS integration-bin


FROM alpine:3.21 AS certificates
RUN apk add --no-cache ca-certificates

FROM node:24.21-trixie-slim
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

ARG S6_OVERLAY_VERSION=3.2.3.2

LABEL org.opencontainers.image.title="Remnacust Node"
LABEL org.opencontainers.image.version="1.1.1"
LABEL org.opencontainers.image.description="Remnacust Node with built-in XRay Core"
LABEL org.opencontainers.image.url="https://github.com/lottman/Remnacust-node"
LABEL org.opencontainers.image.source="https://github.com/lottman/Remnacust-node"
LABEL org.opencontainers.image.vendor="Remnacust"
LABEL org.opencontainers.image.licenses="AGPL-3.0"
LABEL org.opencontainers.image.documentation="https://docs.rw"

WORKDIR /opt/app

COPY --from=build /opt/app/dist ./dist

COPY --from=xray-device-build /tmp/xray /usr/local/bin/xray
COPY --from=xray /usr/local/share/xray/geoip.dat /usr/local/share/xray/geoip.dat
COPY --from=xray /usr/local/share/xray/geosite.dat /usr/local/share/xray/geosite.dat
COPY --from=asn /usr/local/share/asn /usr/local/share/asn
COPY --from=geocheck /usr/local/bin/geocheck /usr/local/bin/geocheck

COPY docker/rootfs/ /

RUN find /etc/s6-overlay -type f -exec sed -i 's/\r//g' {} +

RUN printf 'Acquire::https::CaInfo "/etc/ssl/certs/ca-certificates.crt";\nAPT::Update::Error-Mode "any";\n' > /etc/apt/apt.conf.d/80remnacust-ca \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        ca-certificates wget xz-utils \
    && S6_ARCH="$(uname -m)" \
    && wget -qO /tmp/s6-noarch.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
    && wget -qO /tmp/s6-arch.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
    && xz -dc /tmp/s6-noarch.tar.xz | tar -C / -xpf - \
    && xz -dc /tmp/s6-arch.tar.xz | tar -C / -xpf - \
    && rm -f /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz \
    && mkdir -p /var/log/xray \
    && chmod +x /etc/s6-overlay/scripts/init-env.sh \
        /etc/s6-overlay/s6-rc.d/xray/run \
        /etc/s6-overlay/s6-rc.d/xray-log/run \
    && ln -s /usr/local/bin/xray /usr/local/bin/rw-core \
    && ln -s /opt/app/dist/cli.js /usr/local/bin/cli \
    && printf '#!/bin/sh\ntail -n +1 -f /var/log/xray/current\n' > /usr/local/bin/xlogs \
    && printf '#!/bin/sh\ntail -n +1 -f /var/log/xray/current\n' > /usr/local/bin/xerrors \
    && chmod +x /usr/local/bin/xlogs /usr/local/bin/xerrors \
    && apt-get purge -y --auto-remove xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/include/node

ARG INTEGRATIONS=""

RUN --mount=type=bind,source=docker/integrations,target=/mnt/integrations \
    --mount=type=bind,from=integration-bin,target=/mnt/bin \
    sh /mnt/integrations/install.sh "${INTEGRATIONS}"

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-http-header-size=65536"
ENV UV_THREADPOOL_SIZE=24
ENV XRAY_JSON_STRICT=true
ENV XERA_DEVICE_REVOKE=true
RUN node -e "const fs=require('fs');const app=fs.readFileSync('/opt/app/dist/main.js','utf8');if(!app.includes('xray/managed-core')||!app.includes('capabilityVersion'))throw new Error('Node image is missing core-manager v1')"
ENV XERA_CORE_MANAGER_VERSION=1
ENV S6_VERBOSITY=1

ENTRYPOINT ["/init"]

CMD ["/command/with-contenv", "node", "dist/main.js"]
