[Русский](README.md) · [English](README.en.md)

# Remnacust Node — agent source

Agent **1.1.26** is based on Remnawave Node 3.4.3. Coordinated components are Installer **1.2.138**, panel/page **1.1.7.99**, and Core **1.1.16 / Xray v26.10.31**. The current checkout may contain unreleased changes.

## For operators

Use the [installation and maintenance guide](../README.en.md). Installer 1.2.138 supports Ubuntu 22.04/24.04/26.04 LTS and Debian 12/13, Linux amd64/arm64. The starting baseline is 1 CPU and 1 GiB RAM without a capacity guarantee. With a ready VPS image, Node.js and Go are not needed on the host.

Persistent files are `/opt/remnacust/node/.env` and `/opt/remnacust/node/docker-compose.yml`; actual paths are listed in `/opt/remnacust/FILES.txt`. Preserve `SECRET_KEY`, configuration, certificates and all three state directories from the root README. For an older container without mounts, stop it first and copy its private state with ownership and permissions; do not hide it behind empty mounts during recreation.

## Local configuration

For a source deployment, copy [.env.sample](.env.sample) to `.env` and enter the key from the panel:

```dotenv
NODE_PORT=2222
SECRET_KEY=SECRET_KEY_FROM_PANEL
```

Restrict `.env` permissions to `600` and keep secrets out of Git. The API port must match the node's panel setting. [docker-compose-prod.yml](docker-compose-prod.yml) is a source configuration using host networking and a local build, not a reference to the current stable image. Use the installer from the root README for the ready component set.

The external API requires mTLS and JWT. Separate API access rules from client inbound rules. Internal Unix sockets and state must remain private.

## Development and checks

**Node.js 26.13 LTS** is required. From this directory:

```bash
npm ci
npm run typecheck
node --test tests/*.test.cjs
npm run build
```

Run Unix socket, ownership, permission and network behavior checks on Linux; Windows is not a substitute for that environment. CI commands: [Source checks](../.github/workflows/check.yml).

Build the Docker image from the repository root:

```bash
docker build -f node/docker/Dockerfile -t remnacust-node:local node
```

The Core archive in [docker](docker) is verified using SHA-256. Changing Core requires a complete adjacent Remnacust-core checkout, Go **1.27.3**, and coordinated repackaging with `python3 node/docker/package-remnacust-core.py` from the repository root. README changes do not require this. [Build guide](../docs/BUILDING.md).

## Core, offline operation and compatibility

The image ships custom Core 1.1.16 and separate stock Xray v26.10.31. The panel's global mode defaults to custom; an absent flavor field preserves older panel behavior. An explicit binary switch uses preflight and restart/rollback; changing mode cannot bypass incompatible quotas, policies or live port plans. A verified managed custom Core is preserved instead of being reset to the bundled binary for compatible custom applies.

The agent and Core are updated separately; the image includes a bundled core, but a selected managed Core may remain pinned. Check the active version rather than only the image version. Replacing the process can interrupt connections.

Offline operation is limited by access expiry, remaining USER/HOST/TAG credit and quota period deadlines; a calendar reset does not replenish credit offline. Restart requires persisted configuration, credentials and journals. A day of offline operation requires sufficient reserves and compatible components. Node 1.1.23 and Core 1.1.14 include watchdog/recovery fixes. Tests cover 24 virtual hours with connection failures and recovery; this is not a real day-long network run. [Node changes](../docs/releases/1.1.26.md).

Standard profiles remain compatible with legacy clients within their capabilities. Remnacust extensions and Xera require compatible components; do not disable policy checks to force a downgrade. [Compatibility](../docs/NODE-COMPATIBILITY.md) · [Offline operation requirements](https://github.com/lottman/Remnacust-panel/blob/main/docs/NODE-AUTONOMY.md).

## Attribution and licenses

The fork is maintained by lottman. Attribution to REMNAWAVE and [Remnawave Node](https://github.com/remnawave/node) contributors is retained, along with the agent's **AGPL-3.0-only**, Core's **MPL-2.0** and separate dependency licenses. [NOTICE.md](../NOTICE.md).
