[Русский](README.md) · [English](README.en.md)

# Remnacust Node

The Remnacust agent receives panel configuration, manages Xray and reports statistics. Quota, speed, host and device extensions require a compatible Remnacust Core.

## Current components

| Component | Version |
| --- | --- |
| Installer | [1.2.138](https://github.com/lottman/Remnacust-installer/releases/tag/v1.2.138) |
| Panel and subscription page | [1.1.7.99](https://github.com/lottman/Remnacust-panel/releases/tag/v1.1.7.99) |
| Node | [1.1.24](https://github.com/lottman/Remnacust-node/releases/tag/v1.1.24), based on Remnawave Node 3.4.3 |
| Core | [1.1.15](https://github.com/lottman/Remnacust-core/releases/tag/v1.1.15), Xray v26.10.31 |

The agent and core have independent versions. Updating the panel does not update remote nodes. The current branch may contain unreleased changes.

## VPS installation

Installer 1.2.138 supports **Ubuntu 22.04/24.04/26.04 LTS and Debian 12/13**, Linux **amd64/arm64**.

The starting baseline is **1 CPU and 1 GiB RAM**, without a guaranteed user count, connection count or throughput. Resource use depends on transport, rules, encryption and load. VPS deployments use ready Docker images; Node.js and Go are not needed on the host.

Create a node in the panel and obtain its connection key:

```bash
curl -fsSL --proto '=https' --proto-redir '=https' \
  https://github.com/lottman/Remnacust-installer/releases/download/v1.2.138/installer.sh \
  -o installer.sh
sudo bash installer.sh install-node --version 1.2.138
```

Enter the key and API port (default `2222`); the panel setting must match. For client traffic, separately assign a profile, enable an inbound, allow it for a squad and create a host with the required address and port.

The API uses HTTPS with mTLS and JWT. Restrict API access separately from client ports; keep TLS verification enabled. The `--panel-ip` option restricts **all inbound ports and ICMP to the panel address, except SSH**: direct clients and CDNs using other IPs are also blocked. `NET_ADMIN` is an additional container capability for network operations; select it according to your deployment.

## Persistent files and state

```text
/opt/remnacust/node/.env
/opt/remnacust/node/docker-compose.yml
/opt/remnacust/FILES.txt
/opt/remnacust/backups/
/opt/remnacust/logs/
```

`FILES.txt` lists active paths. Preserve `SECRET_KEY`, the entire `.env`, Compose, certificates and private state. Do not publish keys or the contents of internal directories.

| Host directory beside Compose | Container directory |
| --- | --- |
| `run/` | `/var/lib/remnacust/run` |
| `state/host-policy/` | `/var/lib/remnanode` |
| `state/core-manager/` | `/var/lib/remnawave/core-manager` |

The installer configures these persistent mounts. For an older manual container without mounts, stop it and preserve all three private directories **before recreating it**, for example with `docker cp -a`, retaining ownership and permissions. Empty mounts hide existing checkpoints and journals. Do not delete issued quota state to force startup or a downgrade.

Changing `.env` requires recreation: a regular restart does not reload variables. After ensuring state is preserved and mounts are correct:

```bash
cd /opt/remnacust/node
docker compose config --quiet
docker compose up -d --no-build --pull never
```

## Updates and diagnostics

```bash
sudo remnacust upgrade-node
sudo remnacust manage-node
sudo remnacust status --component node
sudo remnacust logs --component node
sudo remnacust restart --component node
```

`upgrade-node` updates the agent image with its bundled Core. A separately selected managed core may remain pinned: check the actual active version and mode through node management. Updating or selecting Core is a separate operation that checks compatibility with persisted policies.

Compatible runtime profile changes can preserve connections; changing a listener, port, transport or process can interrupt them. Plan maintenance without assuming updates preserve all sessions.

For problems, check the API address, port, key, TLS and firewall, then Core, inbound, host, squad and subscription. An online API status does not prove the client path through a CDN works. [Installer guide](https://github.com/lottman/Remnacust-installer/blob/main/installer/README.md).

## Offline operation and compatibility

A running Core can serve traffic without the panel within existing rights and persisted policies. Access expiry still applies; local credit is limited by remaining grants for applicable USER/HOST/TAG quotas and their period deadlines. A calendar reset does not issue fresh credit without the panel.

A day of offline operation requires enough validity time and local credit for expected traffic and recovery. Restart also requires compatible versions and persisted configuration, credentials and journals. This is not an unconditional 24-hour guarantee for every older installation. [Offline operation requirements](https://github.com/lottman/Remnacust-panel/blob/main/docs/NODE-AUTONOMY.md).

Ordinary Remnawave Node/Xray support standard configurations within their capabilities; they do not automatically gain Remnacust quota, device or recovery extensions. Do not bypass policy checks to install an older core. Xera HTTP (`network: "xera-http"`) requires compatible clients and servers; standard XHTTP is a separate transport. [Compatibility](docs/NODE-COMPATIBILITY.md) · [Limit scopes](https://github.com/lottman/Remnacust-panel/blob/main/docs/HOST-LIMITS.md).

## Node 1.1.24 / Core 1.1.15 changes

Process display names are now `rc-node` and `rc-core` (Core on Linux); the `rw-core` path and management contracts remain compatible. The Core packager rejects incomplete vendored uTLS/olcRTC inputs before writing outputs; Core 1.1.15 is bundled. The previous release's offline recovery fixes remain included, without extending expiry or quotas. [Node changes](docs/RELEASE-1.1.24.md) · [Core changes](https://github.com/lottman/Remnacust-core/blob/main/docs/RELEASE-1.1.15.md).

## Build and documentation

Agent development requires **Node.js 24**; building Core itself requires **Go 1.27.3**. From the repository root:

```bash
docker build -f node/docker/Dockerfile -t remnacust-node:local node
```

This builds the current checkout rather than downloading a stable release. The Core archive is verified using SHA-256; core changes require coordinated repackaging and rebuilding. [Agent development](node/README.en.md) · [Build guide](docs/BUILDING.md) · [Panel](https://github.com/lottman/Remnacust-panel).

## Attribution and licenses

Remnacust is maintained by lottman. The agent derives from [Remnawave Node](https://github.com/remnawave/node), retains attribution to REMNAWAVE and its contributors, and uses **AGPL-3.0-only**. Core retains **MPL-2.0** and XTLS/Xray-core attribution; dependencies retain their own licenses. [NOTICE.md](NOTICE.md) · [Support](https://t.me/lottman).
