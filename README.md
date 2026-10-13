# Dev Instance Manager

Self-hosted management for persistent per-user VS Code Web workspaces on LXD VMs, designed for up to eight users who may execute arbitrary code. **Authentik is not required.** The application has its own local username/password login.

**Security status:** implementation starter, not security-audited or tested on the target LXD host. Do not expose it to users until the host firewall, LXD setup, login flow, VM isolation and recovery have been validated.

## Architecture

- Existing Vite + TypeScript frontend and Fastify API.
- Local accounts provisioned by an administrator from the host shell; passwords are stored as salted scrypt hashes.
- Eight-hour opaque sessions in server memory, sent in an `HttpOnly; SameSite=Strict` cookie (also `Secure` in production). Restarting the API invalidates all sessions.
- One Ubuntu 24.04 LXD VM per local username.
- Every VM has a separate LXD bridge, 2 vCPU, 3 GiB RAM and a 20 GiB root disk.
- The root-owned helper caps allocations at eight per-user workspaces.
- Persistent project directory: `/home/coder/project` on the VM disk.
- code-server listens on port 8080 on the private VM network; the API proxies `/workspace/` and WebSockets.
- The API calls a fixed root-owned helper through sudo; it does not access the LXD socket directly.
- LXD names derive from a SHA-256 hash of the validated username.

## Local account setup

The API reads `/etc/dev-instance-manager/users.json` by default. Keep the file root-owned and writable only by root. The API service user needs read-only group access.

Create the API service account first, following the host setup below. Then create a local user by running the provisioning script from a trusted checkout:

    read -rsp 'Neues Passwort: ' PASSWORD; printf '\n'
    printf '%s' "$PASSWORD" | sudo node infra/create-user.js alice
    unset PASSWORD
    sudo chgrp devmanager /etc/dev-instance-manager/users.json
    sudo chmod 0640 /etc/dev-instance-manager/users.json

Use at least 12 characters for passwords. Repeat the `chgrp` and `chmod` commands after each provisioning/update operation. The script replaces an existing account with the same username, which is useful for password resets. Removing an account from the `users` array disables login; restart the API to invalidate that user's already-issued sessions immediately. Do not commit `users.json` or store passwords in environment variables or command-line arguments.

The username is also used to derive the workspace identity. Use stable usernames; renaming a user creates a different workspace identity.

## API

- `POST /api/auth/login` — verify local credentials and issue a session cookie.
- `GET /api/auth/me` — return the logged-in username.
- `POST /api/auth/logout` — revoke the current in-memory session.
- `GET /api/instance` — current user's workspace status.
- `POST /api/instance/create`
- `POST /api/instance/start`
- `POST /api/instance/stop`
- `GET /api/health` — minimal public health response.
- `/workspace/` — HTTP and WebSocket proxy to the authenticated user's code-server.

Workspace routes accept only a valid local session. Client-supplied identity headers such as `X-Authentik-Username` are ignored. Mutating routes validate the request Origin in production. The login endpoint should also be rate-limited at the reverse proxy.

## Ubuntu/LXD host setup

### 1. Inspect

    lxc version
    lxc info
    lxc network list
    lxc storage list
    ip route
    sudo nft list ruleset

Choose an existing LXD storage pool. Ensure `10.220.0.0/16` does not overlap with LAN, VPN, Docker or LXD routes. The helper reads the pool name from `/etc/dev-instance-manager/storage-pool`.

### 2. Install helper and cloud-init

    sudo install -d -o root -g root -m 0755 /etc/dev-instance-manager
    sudo install -d -o root -g root -m 0700 /var/lib/dev-instance-manager
    sudo install -d -o root -g root -m 0700 /var/lib/dev-instance-manager/networks
    sudo install -m 0750 -o root -g root infra/devvm /usr/local/sbin/devvm
    sudo install -m 0640 -o root -g root infra/cloud-init.yaml /etc/dev-instance-manager/cloud-init.yaml

Write the exact name of the chosen storage pool (only use `default` if it exists):

    printf '%s\n' 'YOUR_EXISTING_POOL_NAME' | sudo tee /etc/dev-instance-manager/storage-pool >/dev/null
    sudo chown root:root /etc/dev-instance-manager/storage-pool
    sudo chmod 0640 /etc/dev-instance-manager/storage-pool

If LXD is not at `/snap/bin/lxc`, edit the helper to use its verified absolute path.

### 3. Service user and sudo

    sudo useradd --system --home /opt/dev-instance-manager --create-home --shell /usr/sbin/nologin devmanager
    sudo install -d -o root -g devmanager -m 0750 /etc/dev-instance-manager
    printf '%s\n' '{"users":[]}' | sudo tee /etc/dev-instance-manager/users.json >/dev/null
    sudo chown root:devmanager /etc/dev-instance-manager/users.json
    sudo chmod 0640 /etc/dev-instance-manager/users.json
    sudo visudo -f /etc/sudoers.d/dev-instance-manager

Sudoers rule:

    devmanager ALL=(root) NOPASSWD: /usr/local/sbin/devvm *

Keep the helper, cloud-init and storage-pool file root-owned and not writable by `devmanager`. The account needs only read access to `users.json`; do not add it to the `lxd` group because LXD access is effectively host-administrator access.

Create at least one user after installing the provisioning script. If you run the script from the repository checkout, keep that checkout trusted and not writable by the service account.

### 4. Firewall

Review `infra/devsandbox.nft.example` against existing nftables rules:

    sudo nft -c -f infra/devsandbox.nft.example

Only after review and rollback planning:

    sudo nft -f infra/devsandbox.nft.example
    sudo nft list table inet devsandbox

Persist rules using the host's existing nftables method. Do not flush the entire firewall. Verify DHCP, VM-to-host denial, VM-to-LAN/VPN denial and intended Internet egress. Separate bridges prevent same-L2 peer traffic. The example still permits outbound traffic to public IPv4 addresses, so arbitrary code can exfiltrate data over the Internet. For stricter use, add an egress proxy/allowlist and explicitly test DNS and IPv6.

### 5. API and frontend

Create `/etc/dev-instance-manager/api.env`:

    NODE_ENV=production
    HOST=127.0.0.1
    PORT=3000
    PUBLIC_BASE_URL=https://dev.example.invalid
    DEVVM_HELPER=/usr/local/sbin/devvm
    DIM_USERS_FILE=/etc/dev-instance-manager/users.json

Replace the example URL with the real HTTPS origin. Keep the environment file root-owned and readable only by root/service user. Configure Fastify/systemd to load it, use `/opt/dev-instance-manager/api` as working directory, and bind to `127.0.0.1:3000`.

Install dependencies from the existing lockfiles and build:

    cd /opt/dev-instance-manager/api
    pnpm install --frozen-lockfile
    pnpm test
    cd /opt/dev-instance-manager/web
    pnpm install --frozen-lockfile
    pnpm build

Serve `web/dist` through the reverse proxy. Keep the API on loopback. Use `infra/nginx-local-auth.example.conf` as a reference for NGINX; replace the domain, TLS paths and filesystem paths. The example includes a login rate limit. Check it with `nginx -t` before reload.

Do not expose code-server port 8080 or API port 3000 to LAN/WAN. code-server uses `--auth none` because the API proxy enforces session access; direct reachability is a critical security failure.

### 6. Back up persistent workspaces

Install the backup helper as a root-owned executable and run it as root:

    sudo install -m 0750 -o root -g root infra/backup-devvm.sh /usr/local/sbin/backup-devvm
    sudo /usr/local/sbin/backup-devvm

Backups are written to `/var/backups/dev-instance-manager` with mode 0600; the directory is mode 0700. The script exports `dev-*` instances and prunes backup files older than seven days. Set `DEVVM_BACKUP_DIR` or `DEVVM_BACKUP_RETENTION_DAYS` for a different destination/retention. Add a root-owned systemd timer or cron job only after testing a restore. Store an additional copy on a different disk or host; a backup on the same physical disk is not disaster recovery.

### 7. Test before users

1. Run `cd api && pnpm test`; tests cover health, rejected identity headers, invalid login requests and the session lifecycle.
2. Confirm unauthenticated dashboard/API/workspace requests fail and a local account can log in/out.
3. Create a test workspace and wait for cloud-init/code-server to finish.
4. Test editor, terminal, Git and WebSockets.
5. Stop/start and confirm project files persist.
6. From the VM, test host, LAN, VPN, Docker bridge and other workspace access; private destinations should fail.
7. Verify intended egress and test DNS/IPv6 behavior.
8. Test the eight-workspace limit with multiple VMs.
9. Back up and restore a VM disk.
10. Verify NGINX login rate limiting and session cookie flags over HTTPS.

## Resource budget

Per user: 2 vCPU, 3 GiB RAM, 20 GiB virtual disk. Eight active VMs can use up to 24 GiB RAM and 160 GiB virtual disk, in addition to Ubuntu and existing services.

## Scope and limitations

Implemented: local password login, salted scrypt password hashes, opaque in-memory sessions, login/logout UI, session-protected workspace actions and proxy, per-user VM naming, create/start/stop/status helper, per-user bridge allocation, persistent project directory, eight-user allocation cap, health endpoint, backup helper and CI.

Not implemented: admin/user management UI, VM deletion, automatic backup scheduling, strict public egress allowlist, automatic resource reclamation and full end-to-end security tests. Sessions are memory-only and are invalidated when the API restarts. Disabling a user does not automatically revoke existing sessions until the API is restarted. The branch has not been tested on the actual LXD host; validate LXD CLI syntax, NGINX config, firewall behavior and VM boot before production.
