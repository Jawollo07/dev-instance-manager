# Dev Instance Manager

Self-hosted management for persistent per-user VS Code Web workspaces on LXD VMs, designed for up to eight users who may execute arbitrary code.

**Security status:** implementation starter, not security-audited. Do not expose it before testing firewall, Authentik, LXD storage/network setup, VM boot and recovery.

## Architecture

- Existing Vite + TypeScript frontend and Fastify API.
- One Ubuntu 24.04 LXD VM per Authentik username.
- Every VM has a separate LXD bridge, 2 vCPU, 3 GiB RAM and a 20 GiB root disk.
- The root-owned helper caps allocations at eight per-user workspaces.
- Persistent project directory: /home/coder/project on the VM disk.
- code-server listens on port 8080 on the private VM network; the API proxies /workspace/ and WebSockets.
- The API uses a fixed root-owned helper via sudo; it does not access the LXD socket directly.
- LXD names derive from a SHA-256 hash of the validated username.

## API

All endpoints require X-authentik-username from the trusted reverse proxy:
- GET /api/instance
- POST /api/instance/create
- POST /api/instance/start
- POST /api/instance/stop
- /workspace/ proxies code-server and WebSockets.

Bind the API only to loopback. Never expose port 3000 directly. NGINX must overwrite X-authentik-username with the authenticated response header, never trust a client-supplied value.

## Ubuntu/LXD host setup

### 1. Inspect

    lxc version
    lxc info
    lxc network list
    lxc storage list
    ip route
    sudo nft list ruleset

Choose an existing LXD storage pool. Ensure 10.220.0.0/16 does not overlap with LAN, VPN, Docker or LXD routes. The helper reads the pool name from /etc/dev-instance-manager/storage-pool.

### 2. Install helper and cloud-init

    sudo install -d -o root -g root -m 0755 /etc/dev-instance-manager
    sudo install -d -o root -g root -m 0700 /var/lib/dev-instance-manager
    sudo install -d -o root -g root -m 0700 /var/lib/dev-instance-manager/networks
    sudo install -m 0750 -o root -g root infra/devvm /usr/local/sbin/devvm
    sudo install -m 0640 -o root -g root infra/cloud-init.yaml /etc/dev-instance-manager/cloud-init.yaml

Write the exact name of the chosen storage pool (only use default if it exists):

    printf '%s\n' 'YOUR_EXISTING_POOL_NAME' | sudo tee /etc/dev-instance-manager/storage-pool >/dev/null
    sudo chown root:root /etc/dev-instance-manager/storage-pool
    sudo chmod 0640 /etc/dev-instance-manager/storage-pool

If LXD is not at /snap/bin/lxc, edit the helper to use its verified absolute path.

### 3. Service user and sudo

    sudo useradd --system --home /opt/dev-instance-manager --create-home --shell /usr/sbin/nologin devmanager
    sudo visudo -f /etc/sudoers.d/dev-instance-manager

Rule:

    devmanager ALL=(root) NOPASSWD: /usr/local/sbin/devvm *

Keep helper, cloud-init and storage-pool file root-owned and not writable by devmanager. Do not add devmanager to the lxd group; LXD access is effectively host-administrator access.

### 4. Firewall

Review infra/devsandbox.nft.example against existing nftables rules:

    sudo nft -c -f infra/devsandbox.nft.example

Only after review and rollback planning:

    sudo nft -f infra/devsandbox.nft.example
    sudo nft list table inet devsandbox

Persist rules using the host's existing nftables method. Do not flush the entire firewall. Verify DHCP, VM-to-host denial, VM-to-LAN/VPN denial and intended Internet egress. Separate bridges prevent same-L2 peer traffic. The example still permits outbound traffic to public IPv4 addresses, so arbitrary code can exfiltrate data over the Internet. For stricter school use, add an egress proxy/allowlist and test DNS/IPv6.

### 5. API and frontend

Create /etc/dev-instance-manager/api.env:

    NODE_ENV=production
    HOST=127.0.0.1
    PORT=3000
    PUBLIC_BASE_URL=https://dev.example.invalid
    DEVVM_HELPER=/usr/local/sbin/devvm

Replace the URL with the real HTTPS origin. Keep the file root-owned and readable only by root/service user. Configure Fastify/systemd to load it, use /opt/dev-instance-manager/api as working directory, and bind to 127.0.0.1:3000.

Install dependencies from the existing lockfiles and build:

    cd /opt/dev-instance-manager/api
    pnpm install --frozen-lockfile
    cd /opt/dev-instance-manager/web
    pnpm install --frozen-lockfile
    pnpm build

Serve web/dist through the reverse proxy. Keep the API on loopback.

### 6. Authentik reverse proxy

Use infra/authentik-nginx.example.conf as a reference, not a complete drop-in vhost. Adapt the outpost address and NGINX locations. Protect dashboard, /api/ and /workspace/ with the same Authentik policy. Overwrite X-authentik-username with Authentik's authenticated response header. Enable WebSockets for /workspace/.

Do not expose code-server port 8080 or API port to LAN/WAN. code-server uses --auth none because the authenticated reverse proxy and API enforce access; direct reachability is a critical security failure.

### 7. Back up persistent workspaces

Install the backup helper as a root-owned executable and run it as root:

    sudo install -m 0750 -o root -g root infra/backup-devvm.sh /usr/local/sbin/backup-devvm
    sudo /usr/local/sbin/backup-devvm

Backups are written to `/var/backups/dev-instance-manager` with mode 0600; the directory is mode 0700. The script exports `dev-*` instances and prunes backup files older than seven days. Set `DEVVM_BACKUP_DIR` or `DEVVM_BACKUP_RETENTION_DAYS` for a different destination/retention. Put the script in a root-owned systemd timer or cron job only after testing a restore. Store an additional copy on a different disk or host; a backup on the same physical disk is not disaster recovery.

### 8. Test before users

1. Run `cd api && pnpm test`; the new tests cover the health endpoint and identity-header rejection.
2. Unauthenticated dashboard/API/workspace requests must fail.
3. Create a test workspace and wait for cloud-init/code-server to finish.
4. Test editor, terminal, Git and WebSockets.
5. Stop/start and confirm project files persist.
6. From the VM, test host, LAN, VPN, Docker bridge and other workspace access; private destinations should fail.
7. Verify intended egress.
8. Test limits with multiple VMs.
9. Back up and restore a VM disk.

## Resource budget

Per user: 2 vCPU, 3 GiB RAM, 20 GiB virtual disk. Eight active VMs can use up to 24 GiB RAM and 160 GiB virtual disk, in addition to Ubuntu and existing services.

## Scope and limitations

Implemented: per-user VM naming, create/start/stop/status helper, per-user bridge allocation, persistent project directory, identity/origin checks, HTTP/WebSocket workspace proxy and dashboard.

Not implemented: VM deletion, admin/user management UI, automated backups, strict public egress allowlist, automatic resource reclamation and end-to-end security tests. First boot needs Internet access for package/code-server installation. This branch has not been tested on the actual LXD host; validate LXD CLI syntax, Authentik headers, nftables behavior and VM boot before production.
