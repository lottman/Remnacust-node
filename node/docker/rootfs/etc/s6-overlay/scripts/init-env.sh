#!/command/with-contenv sh

echo "[init-env] preparing runtime environment..."
umask 077

gen() {
    tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c "${1:-64}"
}

RNDSTR=$(gen 10)
INTERNAL_REST_TOKEN=$(gen 64)
INTERNAL_SOCKET_PATH="rwint-${RNDSTR}"
XTLS_API_DIR="/run/remnacust-xray-${RNDSTR}"
mkdir -m 700 "$XTLS_API_DIR" || exit 1
XTLS_API_SOCKET_PATH="${XTLS_API_DIR}/api.sock"

ENV_DIR=/run/s6/container_environment
mkdir -p "$ENV_DIR"

printf '%s' "$INTERNAL_REST_TOKEN"  > "$ENV_DIR/INTERNAL_REST_TOKEN"
printf '%s' "$INTERNAL_SOCKET_PATH" > "$ENV_DIR/INTERNAL_SOCKET_PATH"
printf '%s' "$XTLS_API_SOCKET_PATH" > "$ENV_DIR/XTLS_API_SOCKET_PATH"

if [ -n "${CUSTOM_CORE_URL:-}" ]; then
    echo "[init-env] downloading custom core"
    core_tmp=$(mktemp /usr/local/bin/.xray-download.XXXXXX) || exit 1
    trap 'rm -f "$core_tmp"' EXIT
    trap 'exit 1' HUP INT TERM
    if ! wget -q --timeout=60 --tries=2 -O "$core_tmp" "$CUSTOM_CORE_URL"; then
        echo "[init-env] ERROR: failed to download custom core"
        exit 1
    fi
    if ! chmod +x "$core_tmp" || ! timeout 10 "$core_tmp" version >/dev/null 2>&1; then
        echo "[init-env] ERROR: downloaded core failed validation"
        exit 1
    fi
    mv -f "$core_tmp" /usr/local/bin/xray || exit 1
    trap - EXIT HUP INT TERM
    echo "[init-env] custom core downloaded and installed successfully"
fi

XRAY_CORE_VERSION=$(/usr/local/bin/rw-core version | head -n 1)
printf '%s' "$XRAY_CORE_VERSION" > "$ENV_DIR/XRAY_CORE_VERSION"
echo "[init-env] Xray version: $XRAY_CORE_VERSION"

echo "[init-env] done."
exit 0
