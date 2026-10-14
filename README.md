# Dev Instance Manager

Self-hosted administration for up to eight persistent VS Code Web workspaces on isolated LXD VMs. Authentik is not required.

## Desired URL layout

- `https://vs.code.de/admin` — admin interface with local session login.
- `https://vs.code.de/test1` — user's own VS Code workspace, protected with HTTP Basic Authentication.
- `https://vs.code.de/test23` — another independent workspace and independent credentials.
- `https://vs.code.de/` redirects to `/admin`.

The workspace application itself is **code-server**, installed and run inside each VM. The browser opens `vs.code.de/<slug>/`; it must not be redirected to `vscode.dev`, an external VS Code host, or a per-VM address. Fastify authenticates every normal request and WebSocket handshake, then proxies it privately to that user's VM. code-server receives its own `--base-path /<slug>` prefix, so generated asset, API, terminal and WebSocket URLs remain beneath the public slug. The Basic Auth header is never forwarded to code-server. All traffic must use HTTPS.

This does not mean the editor pixels are server-rendered: VS Code Web is a browser application, but its HTML, JavaScript, API calls and WebSocket connection are served through this server's domain. The extension gallery uses a fixed-origin Open VSX reverse proxy under `/<slug>/_dim-proxy/open-vsx/`; marketplace URLs are rewritten to the same workspace route and requests require that workspace's Basic Auth. New workspaces also receive standard HTTP(S) proxy environment variables pointing to a host-side Squid proxy at their private bridge gateway. Extension-host and terminal tools that honor these variables route outbound requests through the server, while the Squid ACL blocks private/LAN destinations. Browser-side webviews and extensions that ignore proxy environment variables can still connect directly; strict enforcement requires additional egress firewall policy and compatibility testing.

## Admin interface features

- Create users with a unique username and URL slug.
- Create the user's LXD VM during provisioning.
- List users, URLs, VM state and VM IP.
- Start, stop or create a workspace.
- Disable/enable users, reset passwords and delete a user's VM and account.
- Enforce an eight-user workspace cap.
- Trigger a backup of all `dev-*` VMs from the admin dashboard when the root-owned backup helper is installed.
- Run a manually entered shell command across all running user workspaces and inspect each instance's exit code, stdout and stderr. Commands run as the unprivileged `coder` user, not as root; stopped/missing workspaces are skipped.

CPU/RAM/disk limits are currently configured by the root-owned LXD helper (2 vCPU, 3 GiB RAM, 20 GiB disk). Per-user quota editing, an in-browser backup/restore panel, audit log viewer and automatic backup scheduling are not yet implemented. The existing root backup script can export all `dev-*` VMs.

**Security status:** starter implementation only, not a security audit. Test routing and WebSockets end-to-end before exposing it to users.

## Architecture

- Fastify is the single application entry point, bound to loopback behind NGINX. It serves the built admin frontend at `/admin`, handles `/api/*`, and proxies workspace slugs directly to the matching VM. NGINX only terminates TLS and forwards requests/WebSocket upgrades to Fastify.
- Local user store at `/var/lib/dev-instance-manager-users/users.json`, containing salted scrypt hashes, usernames, URL slugs and roles.
- Admin interface uses an eight-hour opaque in-memory session in an `HttpOnly; SameSite=Strict` cookie, with `Secure` in production. API restart invalidates sessions.
- Workspace URLs use HTTP Basic Auth on every request and WebSocket handshake.
- One Ubuntu 24.04 LXD VM per user; each VM has a separate bridge.
- VM names and network names derive from a hash of the validated URL slug.
- Projects persist on the VM disk under `/home/coder/project`.
- code-server listens on port 8080 on its private VM network with a per-workspace base path.
- API calls the fixed root-owned helper through sudo; it does not access the LXD socket directly.

## 1. Inspect the host

    lxc version
    lxc info
    lxc network list
    lxc storage list
    ip route
    sudo nft list ruleset

Choose an existing LXD storage pool. Ensure `10.220.0.0/16` does not overlap with LAN, VPN, Docker or existing LXD routes.

## 2. Install the helper and cloud-init

From a trusted checkout of this repository:

    sudo install -d -o root -g root -m 0755 /etc/dev-instance-manager
    sudo install -d -o root -g root -m 0700 /var/lib/dev-instance-manager
    sudo install -d -o root -g root -m 0700 /var/lib/dev-instance-manager/networks
    sudo install -m 0750 -o root -g root infra/devvm /usr/local/sbin/devvm
    sudo install -m 0640 -o root -g root infra/cloud-init.yaml /etc/dev-instance-manager/cloud-init.yaml

Set the exact name of the LXD storage pool:

    printf '%s\n' 'YOUR_EXISTING_POOL_NAME' | sudo tee /etc/dev-instance-manager/storage-pool >/dev/null
    sudo chown root:root /etc/dev-instance-manager/storage-pool
    sudo chmod 0640 /etc/dev-instance-manager/storage-pool

The helper currently expects LXD at `/snap/bin/lxc`; verify that path on the host before installing.

## 3. Configure API and users

Keep the user store root-inaccessible to untrusted accounts, install the root-owned helper, and provision an initial administrator with `infra/create-user.js`. See the existing deployment instructions and sudoers policy before changing service ownership.

Production environment:

    NODE_ENV=production
    HOST=127.0.0.1
    PORT=3000
    PUBLIC_BASE_URL=https://vs.code.de
    DEVVM_HELPER=/usr/local/sbin/devvm
    DIM_USERS_FILE=/var/lib/dev-instance-manager-users/users.json

Build the API and frontend with the repository's lockfiles. The API serves generated `web/dist/admin.html` and `web/dist/assets/*` itself; Vite is only for development.

## 4. NGINX and HTTPS

Use `infra/nginx-local-auth.example.conf` as a reference. NGINX does not serve frontend files or decide workspace routes: every request, including `/admin`, `/assets/*`, `/api/*`, `/<slug>` and `/<slug>/*`, is forwarded to Fastify. Fastify serves the admin UI and assets, runs API endpoints, and proxies authenticated workspace traffic and WebSocket upgrades. Do not expose API port 3000 or code-server port 8080 directly.

## 5. Network isolation and backups

Review `infra/devsandbox.nft.example` against the host firewall before applying it; do not flush the whole firewall. Verify VM-to-host/LAN/VPN denial, bridge isolation, DNS and IPv6. Strict egress allowlisting is unfinished, so arbitrary workspace code may access the Internet.

Install and test `infra/backup-devvm.sh` before relying on backups. Test restore, and keep a copy on another disk or host. Deleting a user deletes the VM and its project disk.

## Validation checklist

1. Confirm `/admin` is served by this host and admin APIs require a session.
2. Create a workspace and verify `https://vs.code.de/<slug>/` loads.
3. In browser DevTools Network, confirm workspace HTML, scripts, `/api` calls, WebSockets and Open VSX gallery/download requests use `vs.code.de/<slug>/...`, not `vscode.dev`, `open-vsx.org` or the VM IP.
4. Verify the terminal, editor, extensions, reload and reconnect after restarting the VM.
5. Confirm credentials for one slug do not work on another slug.
6. Test all eight allocations, backups and restore.

## Broadcast commands

The admin dashboard's broadcast command runs on every existing running workspace as the unprivileged `coder` user. Stopped or missing workspaces are skipped. Only trusted administrators should have access.

## Current limitations

- No per-user resource-limit editor in the UI; defaults are 2 vCPU, 3 GiB RAM and 20 GiB disk.
- No UI for restoring backups, viewing audit logs or scheduling backups.
- Admin sessions are in memory and disappear on API restart.
- The implementation still requires end-to-end validation on the actual LXD host and is not security-audited.
