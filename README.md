# Dev Instance Manager

Self-hosted administration for up to eight persistent VS Code Web workspaces on isolated LXD VMs. Authentik is not required.

## Desired URL layout

- `https://vs.code.de/admin` — admin interface with local session login.
- `https://vs.code.de/test1` — user's own VS Code workspace, protected with HTTP Basic Authentication.
- `https://vs.code.de/test23` — another independent workspace and independent credentials.
- `https://vs.code.de/` redirects to `/admin`.

The Basic Auth username/password are the local user's username and password. A credential is accepted only when both the username and requested URL slug match the same enabled workspace account. Requests and WebSocket upgrades are authenticated before proxying, and the Basic Auth header is never forwarded to code-server. All traffic must use HTTPS.

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

**Security status:** starter implementation only, not a security audit. It has not been end-to-end tested on the target Ubuntu/LXD host. Do not expose it to users until the network, VM boot, proxy and restore flows are tested.

## Architecture

- Fastify API bound to loopback behind NGINX.
- Local user store at `/var/lib/dev-instance-manager-users/users.json`, containing salted scrypt hashes, usernames, URL slugs and roles.
- Admin interface uses an eight-hour opaque in-memory session in an `HttpOnly; SameSite=Strict` cookie, with `Secure` in production. API restart invalidates sessions.
- Workspace URLs use HTTP Basic Auth on every request and WebSocket handshake.
- One Ubuntu 24.04 LXD VM per user; each VM has a separate bridge.
- VM names and network names derive from a hash of the validated URL slug.
- Projects persist on the VM disk under `/home/coder/project`.
- code-server listens on port 8080 on its private VM network, with a per-user base path.
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

## 3. Create the API service account and writable user store

    sudo useradd --system --home /opt/dev-instance-manager --create-home --shell /usr/sbin/nologin devmanager
    sudo install -d -o devmanager -g devmanager -m 0700 /var/lib/dev-instance-manager-users
    sudo install -d -o root -g devmanager -m 0750 /etc/dev-instance-manager
    sudo visudo -f /etc/sudoers.d/dev-instance-manager

Sudoers rule:

    devmanager ALL=(root) NOPASSWD: /usr/local/sbin/devvm *, /usr/local/sbin/backup-devvm

Keep `/usr/local/sbin/devvm`, cloud-init and the storage-pool file root-owned and not writable by the API service. Do not add `devmanager` to the `lxd` group; LXD access is effectively host-administrator access.

The API account store is writable by `devmanager` so the admin interface can create accounts and reset passwords. That is a deliberate trust boundary: a compromise of the API process can alter application accounts, but must not grant direct LXD/socket or arbitrary root access.

## 4. Bootstrap the first administrator

Create the store directory as above, then provision the first admin from a trusted checkout installed at `/opt/dev-instance-manager`. Read the password from the terminal and pipe it to the script; do not put it in command-line arguments.

    read -rsp 'Admin-Passwort (mind. 12 Zeichen): ' PASSWORD; printf '\n'
    printf '%s' "$PASSWORD" | sudo -u devmanager env DIM_USERS_FILE=/var/lib/dev-instance-manager-users/users.json node /opt/dev-instance-manager/infra/create-user.js admin admin --admin
    unset PASSWORD

The example creates an admin login named `admin` and a slug named `admin`. The admin account is for the dashboard; it does not get a normal user workspace. Use a unique, strong password.

The script accepts `<username> <slug> [--admin]`. User slugs must be lowercase letters, numbers and hyphens, start with a letter or number, and be at most 32 characters.

## 5. Configure the API

Create `/etc/dev-instance-manager/api.env`:

    NODE_ENV=production
    HOST=127.0.0.1
    PORT=3000
    PUBLIC_BASE_URL=https://vs.code.de
    DEVVM_HELPER=/usr/local/sbin/devvm
    DIM_USERS_FILE=/var/lib/dev-instance-manager-users/users.json

Set owner/mode appropriately for the service and configure systemd to load this file. Run the API with working directory `/opt/dev-instance-manager/api`, bound only to `127.0.0.1:3000`.

Install dependencies and build:

    cd /opt/dev-instance-manager/api
    pnpm install --frozen-lockfile
    pnpm test
    cd /opt/dev-instance-manager/web
    pnpm install --frozen-lockfile
    pnpm build

## 6. NGINX and HTTPS

Use `infra/nginx-local-auth.example.conf` as a reference. Replace the TLS paths and root directory, and add both `limit_req_zone` directives and the `map` directive to the NGINX `http {}` context. The configuration routes:

- `/admin` to the dashboard HTML.
- `/api/*` to the API.
- `/<slug>` and `/<slug>/*` to the Basic Auth workspace proxy.
- Static assets to the built frontend.

Check before reload:

    sudo nginx -t

Do not expose API port 3000 or code-server port 8080 directly. code-server is configured with `--auth none` because the API proxy performs Basic Auth; direct reachability to port 8080 would bypass that protection. The proxy must pass Authorization to the API, which validates it, and the API must strip it before sending requests upstream.

## 7. Network isolation

Review `infra/devsandbox.nft.example` against the host's current firewall:

    sudo nft -c -f infra/devsandbox.nft.example

Only apply it after review and rollback planning. Do not flush the entire firewall. Verify DHCP, VM-to-host denial, VM-to-LAN/VPN denial, isolation between bridges, DNS and IPv6. The current example allows outbound traffic to public IPv4 addresses, so arbitrary code can exfiltrate data. Strict egress allowlisting remains unfinished.

## 8. Backups

The root backup helper exports all `dev-*` VMs. Install it before using the dashboard's **Backup aller Workspaces** action:

    sudo install -m 0750 -o root -g root infra/backup-devvm.sh /usr/local/sbin/backup-devvm
    sudo /usr/local/sbin/backup-devvm

Backups use restrictive permissions and default to seven-day retention. Test a restore before scheduling it. Keep another copy on a different disk or host; same-disk backups are not disaster recovery. **Deleting a user from the admin interface deletes the VM and its project disk. Back it up first.**

## 9. Validation checklist

1. Confirm `/admin` requires an admin session and a normal user gets HTTP 403 from admin APIs.
2. Create a user and verify `https://vs.code.de/<slug>` prompts for Basic Auth.
3. Confirm that credentials for one slug do not work on another slug.
4. Verify browser editor, terminal, Git and WebSockets.
5. Stop/start the VM and verify project files persist.
6. From the VM, test host, LAN, VPN, Docker and other-workspace access.
7. Verify intended egress, DNS and IPv6 behavior.
8. Test all eight allocations, backups and restore.
9. Verify NGINX rate limiting and HTTPS cookie flags.

## Broadcast commands

The admin dashboard includes a **Befehl auf allen Instanzen ausführen** panel. It sends the command to every configured user workspace that currently exists and is running. Each command is executed inside that VM as the named unprivileged `coder` account via `runuser`; it is not executed as root. Stopped or missing instances are reported as skipped. Output and exit codes are shown separately per workspace. The command is arbitrary shell input, so only trusted administrators should have dashboard access. Review commands carefully before confirming, especially commands that modify or delete files. The feature requires the updated `infra/devvm` helper to be installed at `/usr/local/sbin/devvm` on the host; re-install it after updating the repository.

## Current limitations

- No per-user resource-limit editor in the UI yet; defaults are 2 vCPU, 3 GiB RAM and 20 GiB disk.
- No UI for restoring backups, viewing audit logs, editing resource limits or scheduling backups.
- Disabling an account blocks new Basic Auth requests, but does not immediately revoke an already-authenticated browser's cached Basic Auth credentials; it will be rejected on the next request.
- Admin sessions are in memory and disappear on API restart.
- The implementation has not been validated on the actual LXD host and is not security-audited.
