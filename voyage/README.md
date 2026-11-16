# Voyage: multi-tenant travel management SaaS

Each customer gets its own PostgreSQL database, its own container, its own subdomain and its own
application version. A central control plane provisions and updates these automatically, with no manual
steps per customer.

```
acmetravel.<BASE_DOMAIN>   -> nginx -> voyage-tenant-acmetravel (v2) -> tenant_acmetravel DB
cedartrips.<BASE_DOMAIN>   -> nginx -> voyage-tenant-cedartrips (v1) -> tenant_cedartrips DB
<BASE_DOMAIN>              -> nginx -> voyage-control (registration, status, admin)
```

## Layout

| Path | What it is |
|---|---|
| `tenant-app/` | The tenant application: Express + PostgreSQL API and React/Vite/Tailwind dashboard. One image per release (`voyage-tenant:v1`, `:v2`). |
| `control-plane/` | Registration, provisioning, nginx routing, version deploy/rollback, admin page. The only service that mounts the Docker socket. |
| `nginx/nginx.conf` | Edge proxy. Loads one generated file per tenant from a shared volume. |
| `postgres/init/` | Creates the `voyage_provisioner` role (no superuser) and the control database. |
| `docker-compose.yml` | Runs the central platform. Tenant containers are created at runtime by the control plane. |
| `scripts/build-tenant-images.sh` | Builds the tenant images for each version. |

## Run locally

Requirements: Docker with Compose v2, Node 22 (only if you run the tests).

```bash
cp .env.example .env            # replace every CHANGE_ME value
scripts/build-tenant-images.sh v1 v2
docker compose up -d --build
```

1. Open http://localhost:8080 and register a company. Provisioning status updates live.
2. When status is **Workspace Ready**, open the link. Chrome and Firefox resolve `*.localhost` to 127.0.0.1,
   so the workspace is `http://<slug>.localhost:8080`.
3. Admin page: http://localhost:8080/#/admin (token = `ADMIN_TOKEN` from `.env`).

Deploy one tenant to a new version (other tenants are not touched):

```bash
curl -X POST localhost:8080/api/admin/tenants/<slug>/deploy \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"version":"v2"}'
curl -X POST localhost:8080/api/admin/tenants/<slug>/rollback -H "Authorization: Bearer $ADMIN_TOKEN"
```

## What happens on registration

1. Validate input; reject control characters and malformed email or password.
2. Create a unique slug. Retrying the same company and email returns the same workspace (no duplicates).
3. Create a PostgreSQL role `tenant_<slug>` and database `tenant_<slug>`. The role can connect only to its own database.
4. Verify the image exists, ensure the `voyage-net` network, and create and start the container
   with that tenant's DB URL and JWT secret. The admin account is created on first start.
5. Write the nginx route, run `nginx -t`, and reload. If the test fails, the previous route is restored.
6. Poll `/api/health` until the DB is reachable, the admin exists, and the version matches.
7. Mark the workspace ready and clear the one-time admin password hash from the control DB.

Every step is recorded in `tenants.provisioning_log`, so the status page shows what actually happened.
Failed steps show the error, and **Retry** re-runs them safely.

## Versioning and isolation

- Tenant credentials and JWT secrets are derived with HMAC from `CONTROL_SECRET`. They are never stored,
  and they are identical when a container is recreated.
- A deploy recreates only that tenant's container. Its database is untouched.
- If the new version fails its health check, the control plane rolls back to the previous image automatically.
- `tenants.version` and `previous_version` record the state. Rollback is one call.

## Tests

```bash
cd tenant-app && npm ci && npm run build       # builds the SPA the tenant server serves
cd ../control-plane && npm ci && npm test
```

The suite runs 28 checks: validation, five-customer registration, idempotent retries, separate databases and
roles (including a rejected cross-tenant DB connection), per-tenant containers and nginx routes, CRUD for
trips, itinerary, destinations, expenses and settings, persistence across container restarts, token
isolation between tenants, and the v2 upgrade of Client A with B, C, D and E confirmed unchanged, followed
by rollback.

### What the test does and does not prove

The sandbox used to build this has PostgreSQL 16 and nginx, but no Docker daemon. So the test runs
the real control plane against the real PostgreSQL, and the real tenant application runs as processes.
Only the Docker Engine API is replaced (`control-plane/test/fake-docker.mjs`); it maps each container
name to a loopback address the way Docker's DNS would.

| Verified by the test | Not verified here (needs a real Docker host / DNS) |
|---|---|
| Provisioning logic, DB/role creation and grants | Real `docker create/start/exec` against the daemon |
| Tenant app CRUD, auth, persistence, validation | Container networking and Docker DNS resolution |
| Generated nginx configs pass `nginx -t` | Live request routing through the nginx container |
| Version deploy, isolation, rollback | Wildcard DNS and TLS |

Run `docker compose up` on a host and register one company before you rely on it.

## AWS EC2

1. Launch an EC2 instance with Docker and Compose installed. Open only ports 80 and 443 (and 22 from your IP).
   Do not open 5432: Postgres is on the internal Docker network only.
2. DNS: create a wildcard record `*.voyage.example.com` and an apex record, both pointing to the instance.
3. In `.env`, set `BASE_DOMAIN=voyage.example.com` and `WORKSPACE_SCHEME=https`.
4. TLS: terminate HTTPS in front of nginx with a wildcard certificate (an ALB with ACM, or certbot DNS validation).
   The current nginx config serves HTTP on port 80 and needs an HTTPS listener added.
5. Use `DOCKER_GID` from the instance (`getent group docker | cut -d: -f3`).
6. Build the tenant images on the instance, or push them to ECR and set `TENANT_IMAGE_REPO` to the ECR path.

## Security notes and known limits

- **The Docker socket is root-equivalent on the host.** Only `voyage-control` mounts it, and it runs as a
  non-root user in the `docker` group. Treat that container as a privileged component. Keep it off the internet.
- `GET /api/tenants/:slug` is public so the status page works. Anyone who knows a slug can see the company
  name and provisioning steps (not secrets). Add a per-registration token if this matters to you.
- Registration and public retry have no rate limit. Put a WAF or nginx `limit_req` in front for production.
- Tenant containers receive their DB password and JWT secret as environment variables, visible to anyone who can
  run `docker inspect`. Restrict Docker access accordingly.
- Changing `CONTROL_SECRET` invalidates all existing tenant credentials. Back it up with the control DB.
- Tenant schema is applied with `CREATE ... IF NOT EXISTS` on every start. Future schema changes must be
  additive or move to a migration version table before the first breaking change ships.
- The v1 and v2 images differ only by version marker today. Real v2 changes are a code change plus a new build.
- Backups: `pgdata` (control DB and all tenant DBs) is the only state that matters. Back it up with `pg_dumpall`.
