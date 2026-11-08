[Русский](README.md) · [English](README.en.md)

# Remnacust Node

The Remnacust agent receives panel configuration, manages Xray and reports statistics. Quota, speed, host and device extensions require a compatible Remnacust Core.

## Current components

| Component | Version |
| --- | --- |
| Installer | [1.2.144](https://github.com/lottman/Remnacust-installer/releases/tag/v1.2.144) |
| Panel and subscription page | [1.1.7.100](https://github.com/lottman/Remnacust-panel/releases/tag/v1.1.7.100) |
| Node | [1.1.26](https://github.com/lottman/Remnacust-node/releases/tag/v1.1.26), based on Remnawave Node 3.4.3 |
| Core | [1.1.16](https://github.com/lottman/Remnacust-core/releases/tag/v1.1.16), Xray v26.10.31 |

The agent and core have independent versions. Updating the panel does not update remote nodes. The current branch may contain unreleased changes.

## VPS installation

Installer 1.2.144 supports **Ubuntu 22.04/24.04/26.04 LTS and Debian 12/13**, Linux **amd64/arm64**.

The starting baseline is **1 CPU and 1 GiB RAM**, without a guaranteed user count, connection count or throughput. Resource use depends on transport, rules, encryption and load. VPS deployments use ready Docker images; Node.js and Go are not needed on the host.

Create a node in the panel and obtain its connection key:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/lottman/Remnacust-installer/main/Install.sh) @ install-node
```

The command downloads the latest stable installer. Press Enter at the version prompt to select Latest; `--version` is only needed to pin a specific release.

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

## Node 1.1.26 / Core 1.1.16 changes

Runtime moves to Node.js 26.13 LTS. The image contains custom Core 1.1.16 (`/usr/local/bin/xray`) and stock Xray v26.10.31 (`/usr/local/bin/xray-default`). The panel's global mode defaults to custom. Default is checked before replacing the process and rejects incompatible quotas, policies or live port plans; journals are retained and limits are not silently removed. Changing binaries uses restart and verified rollback and can interrupt connections. A verified managed custom Core is preserved for compatible custom applies.

Process display names are now `rc-node` and `rc-core` (Core on Linux); the `rw-core` path and management contracts remain compatible. The Core packager rejects incomplete vendored uTLS/olcRTC inputs before writing outputs; Core 1.1.16 is bundled. The previous release's offline recovery fixes remain included, without extending expiry or quotas. [Node changes](docs/releases/1.1.26.md) · [Core changes](https://github.com/lottman/Remnacust-core/blob/main/docs/releases/1.1.16.md).

## Build and documentation

Agent development requires **Node.js 26.13 LTS**; building Core itself requires **Go 1.27.3**. From the repository root:

```bash
docker build -f node/docker/Dockerfile -t remnacust-node:local node
```

This builds the current checkout rather than downloading a stable release. The Core archive is verified using SHA-256; core changes require coordinated repackaging and rebuilding. [Agent development](node/README.en.md) · [Build guide](docs/BUILDING.md) · [Panel](https://github.com/lottman/Remnacust-panel).

## Attribution and licenses

Remnacust is maintained by lottman. The agent derives from [Remnawave Node](https://github.com/remnawave/node), retains attribution to REMNAWAVE and its contributors, and uses **AGPL-3.0-only**. Core retains **MPL-2.0** and XTLS/Xray-core attribution; dependencies retain their own licenses. [NOTICE.md](NOTICE.md) · [Support](https://t.me/lottman).
