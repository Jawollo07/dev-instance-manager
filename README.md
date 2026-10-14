# Dev Instance Manager

[![CI](https://github.com/Jawollo07/dev-instance-manager/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Jawollo07/dev-instance-manager/actions/workflows/ci.yml)

Self-hosted management for up to **eight persistent VS Code Web workspaces**, with one isolated LXD virtual machine per user. The project uses a local account store and does **not** require Authentik.

> **Status: homelab / starter deployment.** The API tests and frontend build run in CI, but that is not a security audit or proof that the firewall, LXD host and public deployment are safe. Follow the validation checklist before giving accounts to other people.

## Contents

- [What it does](#what-it-does)
- [URLs and request flow](#urls-and-request-flow)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Create the first administrator](#create-the-first-administrator)
- [Reverse proxy and HTTPS](#reverse-proxy-and-https)
- [Workspace egress proxy](#workspace-egress-proxy-optional-but-recommended)
- [Backups](#backups)
- [API and development](#api-and-development)
- [Security model and limitations](#security-model-and-limitations)
- [Validation checklist](#validation-checklist)
- [Roadmap](#roadmap)

## What it does

### Admin dashboard

- Create regular accounts with a workspace VM or administrator accounts directly in the dashboard.
- Change account roles, reset passwords, and lock or unlock accounts. The API refuses to disable, demote, or delete the last active administrator.
- View accounts, workspace URLs, VM state and reported VM IP.
- Start, stop and delete workspaces.
- Enable or disable accounts and reset passwords.
- Enforce a maximum of eight user workspaces.
- Trigger an export of `dev-*` VMs when the root-owned backup helper is installed and permitted.
- Run an explicitly entered command across running user workspaces as the unprivileged `coder` account. Stopped or missing VMs are skipped; each result includes a status and, when available, exit code and output.
- View the most recent audit events in the dashboard. The protected endpoint is `GET /api/admin/audit?limit=100`.

### Per-user workspace

- Each user gets a separate LXD VM and private bridge.
- The VS Code Web interface is provided by code-server inside that VM.
- Project files persist on the VM disk under `/home/coder/project` when the VM is stopped and started again.
- Each workspace has a slug-based URL. Users are restricted to their assigned workspace; enabled admin accounts can open any workspace after signing in. HTTP Basic Auth remains supported for compatible clients.
- The helper configures a baseline of **2 vCPU, 3 GiB RAM and 20 GiB disk** per workspace. These values are not currently editable in the dashboard.
- The extension gallery is configured to use a same-origin Open VSX reverse-proxy route.

## URLs and request flow

Example public URLs:

| URL | Purpose |
| --- | --- |
| `https://vs.code.de/` | Shared login; admins go to `/admin`, users go to their own workspace |
| `https://vs.code.de/admin` | Admin login and management dashboard |
| `https://vs.code.de/test1/` | Workspace for the `test1` slug |
| `https://vs.code.de/test23/` | A different workspace; admins can also open it after signing in |
| `https://vs.code.de/api/health` | API health endpoint |

The intended request path is:

```text
Browser
  │ HTTPS
  ▼
NGINX (TLS termination)
  │ HTTP over loopback
  ▼
Fastify API ─── local account store / audit log
  │
  ├── /admin, /assets/*, /api/*
  │
  └── /<slug>/* ── authenticate slug ──► matching private LXD VM
                                         └── code-server :8080
```

NGINX should forward all paths to Fastify. Fastify serves the shared login frontend, handles API requests, checks role-aware session/Basic Auth for workspace access, and proxies HTTP and WebSocket traffic to the matching VM. Admins can access any valid workspace slug; regular users can access only their assigned slug. Do not publish the Fastify port or the VM's code-server port directly to the Internet.

The editor itself is a browser application, not a server-rendered desktop. Its application assets, API calls and WebSocket connection should nevertheless use the public `vs.code.de/<slug>/...` route rather than a VM address or an unrelated VS Code host.

## Architecture

- **Frontend:** TypeScript and Vite; the production build is served by Fastify.
- **API:** Node.js and Fastify.
- **Workspace runtime:** code-server in one Ubuntu LXD VM per user.
- **Identity:** local user JSON store with scrypt password hashes; no external identity provider is required.
- **Admin session:** opaque in-memory session in an HttpOnly cookie, with Secure enabled in production. Restarting the API invalidates active sessions.
- **Workspace access:** HTTP Basic Auth is checked by the proxy for workspace HTTP requests and WebSocket handshakes. Credentials are not forwarded to code-server.
- **VM management:** a narrowly scoped root-owned helper is invoked through `sudo -n`; the API does not access the LXD socket directly.
- **Workspace networks:** separate bridge names and subnets are derived from a validated slug. The configured pool is `10.220.0.0/16`; ensure it does not overlap with LAN, VPN, Docker or existing LXD routes.
- **Audit log:** append-only JSONL records beside the configured users file, with restrictive filesystem permissions. Passwords and shell command text are intentionally not recorded.

## Requirements

Host setup is designed for an Ubuntu server with LXD available. Before deploying, verify:

- Node.js and pnpm versions compatible with the lockfiles and CI (CI currently uses Node.js 22 and pnpm 10).
- LXD is installed, initialized and has an existing storage pool.
- The helper's configured LXD CLI path, `/snap/bin/lxc`, exists.
- NGINX or an equivalent TLS reverse proxy is configured for WebSocket upgrades.
- The public hostname resolves to the reverse proxy and a valid TLS certificate is installed.
- The `10.220.0.0/16` workspace address pool is unused by existing routes.
- You have reviewed the firewall and understand that workspace code is untrusted.

Useful host inspection commands:

```bash
lxc version
lxc info
lxc network list
lxc storage list
ip route
sudo nft list ruleset
```

## Installation

These steps install the privileged VM helper and cloud-init template. They do not automatically deploy the Node.js API, configure NGINX, or make the service production-ready.

### 1. Get the repository

```bash
git clone https://github.com/Jawollo07/dev-instance-manager.git
cd dev-instance-manager
```

If you already have a checkout, review your local changes before pulling updates.

### 2. Install the host helper and configuration

Run from the trusted repository checkout:

```bash
sudo install -d -o root -g root -m 0755 /etc/dev-instance-manager
sudo install -d -o root -g root -m 0700 /var/lib/dev-instance-manager
sudo install -d -o root -g root -m 0700 /var/lib/dev-instance-manager/networks
sudo install -m 0750 -o root -g root infra/devvm /usr/local/sbin/devvm
sudo install -m 0640 -o root -g root infra/cloud-init.yaml /etc/dev-instance-manager/cloud-init.yaml
```

Choose an **existing** LXD storage pool by its exact name:

```bash
printf '%s\\n' 'YOUR_EXISTING_POOL_NAME' | sudo tee /etc/dev-instance-manager/storage-pool >/dev/null
sudo chown root:root /etc/dev-instance-manager/storage-pool
sudo chmod 0640 /etc/dev-instance-manager/storage-pool
```

Check that the pool name and LXD CLI path match your host. Do not create a new pool or change existing networking blindly.

### 3. Prepare the local account store

The API needs a writable account store, while the store must not be accessible to untrusted workspace users. The default path is:

```text
/var/lib/dev-instance-manager-users/users.json
```

Create the directory with ownership for the dedicated API service account you intend to run the application as. For example, if that account is named `dim-api`:

```bash
sudo install -d -o dim-api -g dim-api -m 0700 /var/lib/dev-instance-manager-users
```

Use the same service account for the initial account-creation command and the running API. Do not run the API as root.

### 4. Configure the API environment

Configure these environment variables in your service manager or deployment environment:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_BASE_URL=https://vs.code.de
DEVVM_HELPER=/usr/local/sbin/devvm
DIM_USERS_FILE=/var/lib/dev-instance-manager-users/users.json
```

If you install the backup helper at `/usr/local/sbin/backup-devvm`, also configure the matching sudo permission and, if needed, `DEVVM_BACKUP_HELPER`. The API's privileged helper commands must be limited to the exact root-owned scripts and arguments required by this project. Review the sudoers policy before enabling them.

Install API dependencies and build the frontend using the lockfiles:

```bash
cd api
pnpm install --frozen-lockfile
pnpm test
cd ../web
pnpm install --frozen-lockfile
pnpm build
```

The production API serves the generated `web/dist/admin.html` and `web/dist/assets/*` files. Vite's dev server is for development only.

> **Deployment note:** Configure a persistent service for the API using your chosen service manager. Keep it bound to loopback, use a dedicated unprivileged account, and ensure the built frontend is available at the path expected by the application. Review the repository's helper and route code before granting sudo access.

## Create the first administrator

The helper `infra/create-user.js` reads the password from standard input, so the password does not appear in the process argument list. Run it as the same service account that owns the account store.

Example, substituting your actual service account and a strong password entered interactively:

```bash
read -rsp 'Initial admin password: ' DIM_ADMIN_PASSWORD
printf '\\n'
printf '%s' "$DIM_ADMIN_PASSWORD" | sudo -u dim-api env DIM_USERS_FILE=/var/lib/dev-instance-manager-users/users.json node infra/create-user.js admin admin --admin
unset DIM_ADMIN_PASSWORD
```

Use a unique, strong password of at least 12 characters. The username and slug must be unique; slugs may contain lowercase letters, digits and hyphens. Protect shell history and the terminal session, and avoid putting passwords directly in scripts or command-line arguments.

## Reverse proxy and HTTPS

Use `infra/nginx-local-auth.example.conf` as a starting point, adapting certificate paths and the upstream as required. It is an example, not a drop-in configuration.

- Terminate TLS at NGINX.
- Forward **all** routes to Fastify on `127.0.0.1:3000), including `/admin`, `/assets/*`, `/api/*` and workspace slugs.
- Preserve the `Host`, forwarded protocol and client address headers as appropriate.
- Support HTTP/1.1 WebSocket upgrades and long-lived connections.
- Apply login rate limiting at the edge.
- Do not expose port 3000 or port 8080 publicly.
- Configure the application public URL as `https://vs.code.de`.

The application uses the public origin to validate origins for state-changing admin endpoints. Ensure the configured URL exactly matches the browser origin.

## Workspace egress proxy (optional but recommended)

New workspace cloud-init configuration sets `HTTP_PROXY` and `HTTPS_PROXY` to a host-side Squid proxy at the workspace's private bridge gateway, port 3128. The example configuration is in `infra/squid-workspace-egress.conf`.

Review before enabling:

1. Install Squid and confirm that your main configuration includes the appropriate `conf.d` directory.
2. Review the ACLs and ensure only the intended workspace subnet can use the proxy.
3. Validate the configuration with `sudo squid -k parse` before reloading the service.
4. Review `infra/devsandbox.nft.example` against the host's **existing** nftables rules. Merge only the required rules; do not flush or replace your active firewall.
5. Test access to public package registries and verify that LAN, host, VPN and link-local destinations are blocked from workspace networks.

This proxy only affects applications that honor the standard proxy environment variables. Browser webviews and extensions that ignore them may connect directly. Full outbound allowlisting and enforcement are not yet complete, so this setup must not be treated as a guarantee that arbitrary workspace code cannot reach the Internet or other destinations. Compatibility and firewall behavior must be tested on the actual host.

## Backups

The root-owned helper `infra/backup-devvm.sh` exports LXD instances whose names begin with `dev-`. The default backup directory is:

```text
/var/backups/dev-instance-manager
```

Backups are created with restrictive permissions. The helper supports these environment variables:

- `DEVVM_BACKUP_DIR` — backup destination.
- `DEVVM_BACKUP_RETENTION_DAYS` — retention age in days (1–99; default 7).

Install it as a root-owned executable and allow the API service account to run only that exact helper if you want to trigger backups from the dashboard. Back up to storage with enough capacity. A backup stored only on the same host is not disaster recovery.

**Before relying on backups:** perform a test export, verify the resulting archive, and document and test a restore procedure. The dashboard does not currently provide a restore workflow or a backup schedule. Deleting a user deletes that user's VM and project disk.

## API and development

### API

```bash
cd api
pnpm install --frozen-lockfile
pnpm test
pnpm dev
```

### Frontend

```bash
cd web
pnpm install --frozen-lockfile
pnpm dev
```

The frontend's Vite configuration proxies API and workspace requests to the development API. For production, build the frontend and let Fastify serve it.

### Health check

```bash
curl -i http://127.0.0.1:3000/api/health
```

Adjust the port if your development or production configuration differs.

### Continuous integration

GitHub Actions runs the API test suite and the frontend type-check/build on pushes to `master` and `feat/**`, pull requests, and manual workflow dispatches. Passing CI checks code-level behavior only; it does not exercise your actual LXD host, firewall, public DNS or TLS configuration.

## Security model and limitations

Treat workspace users as **untrusted**: they can run arbitrary programs and build tools inside their own VM. Isolation still depends on the host kernel, LXD configuration, firewall rules, proxy policy and the privileged helper.

- Each workspace has its own VM and private bridge; avoid shared host mounts, the Docker socket, the LXD socket and privileged host access.
- The API should run unprivileged. Keep the LXD helper and its configuration root-owned and non-writable by the API user.
- Keep the user store, session state and audit log inaccessible to workspace accounts.
- Use HTTPS for every public request. Basic Auth credentials are not safe over plaintext HTTP.
- Admin sessions are in memory and are invalidated by an API restart.
- The audit log records recent administrative events; it is not a tamper-proof, externally shipped security log.
- Per-user resource limits cannot yet be edited in the UI.
- Backup restore and automatic backup scheduling are not implemented in the dashboard.
- Egress controls are incomplete; do not promise Internet isolation or strict outbound allowlisting.
- The implementation has not undergone a formal security audit.

## Validation checklist

Before inviting users, test from a separate client and inspect both browser developer tools and host logs.

- [ ] `/admin` loads over HTTPS; `/` redirects to `/admin`.
- [ ] Unauthenticated admin API requests are rejected.
- [ ] A regular user cannot call admin endpoints.
- [ ] A new workspace provisions successfully and `https://vs.code.de/<slug>/` loads.
- [ ] Workspace requests and WebSocket connections use the expected slug prefix and do not expose the VM IP.
- [ ] Credentials for one slug cannot access another user's workspace.
- [ ] Start, stop and restart preserve project files.
- [ ] Terminal, Git, extensions, gallery downloads, reload and reconnect work as expected.
- [ ] Test extension gallery and package downloads in browser DevTools; identify any connections that bypass the configured proxy.
- [ ] Workspace VMs cannot reach host, LAN, VPN, private, link-local or other workspace destinations except explicitly permitted services.
- [ ] Test IPv4 and IPv6 separately; confirm there is no alternate route around the firewall.
- [ ] Test the maximum of eight workspaces and expected resource pressure.
- [ ] Create a backup and complete a test restore.
- [ ] Review logs and file permissions; confirm secrets and shell command text are not recorded in the audit log.

## Roadmap

- Per-user CPU, RAM and disk quota controls in the dashboard.
- Backup inventory, restore workflow and configurable backup scheduling.
- Stronger, tested outbound network policy and destination allowlisting.
- End-to-end deployment and security testing on the target LXD host.
