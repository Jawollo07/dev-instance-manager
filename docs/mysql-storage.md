# MySQL storage

The API now stores users, persistent browser sessions, and audit events in MariaDB/MySQL.
Workspace files remain on the workspace instances.

## Environment

Set these variables for the API systemd service (use a root-owned EnvironmentFile with mode 0600):

```ini
DB_HOST=localhost
DB_PORT=3306
DB_NAME=dev_instance_manager
DB_USER=dim_app
DB_PASSWORD=replace-with-a-long-random-secret
DB_POOL_SIZE=10
```

Do not commit the real password. The API creates its tables automatically at startup. If the users table is empty, it imports valid user records from the existing `DIM_USERS_FILE` JSON file (default `/var/lib/dev-instance-manager-users/users.json`) once. It does not overwrite existing database users. Keep a backup of the legacy file until you have verified the import.

Install the dependency and refresh the pnpm lockfile from the `api` directory:

```sh
pnpm install
```

Restart the service after setting the environment. Verify login, admin user management, workspace routing, and audit history before deleting any legacy files.

## Tables

- `dim_users`: usernames, route slugs, roles, disabled state, salts and password hashes
- `dim_sessions`: SHA-256 hashes of session tokens and expiry times
- `dim_audit`: administrative audit events and JSON details
