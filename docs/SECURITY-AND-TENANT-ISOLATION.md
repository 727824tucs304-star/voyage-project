# Security and tenant isolation

## Controls in place
| Control | How it works | Tested |
|---|---|---|
| Separate database per customer | Each customer has its own PostgreSQL database and login role | Yes: a customer's login cannot connect to another customer's database |
| Separate container and storage per customer | Each workspace runs in its own container with its own storage volume | Yes |
| Tokens are per customer | A token from one workspace is rejected by every other workspace | Yes |
| Customer sign-in limit | 5 failed attempts per account in 15 minutes are blocked | Yes |
| Admin sign-in limit | 10 attempts per 15 minutes per address | Yes |
| Registration limit | 5 registrations per hour per address | Yes (set high during tests) |
| Password storage | bcrypt hashes; cleared from the control plane after provisioning | Yes |
| Team permissions | Only administrators add, reset or remove team members; nobody removes their own account; the last administrator cannot be removed | Yes |
| Private recordings | Stored in each customer's own storage; download requires sign-in | Yes |
| Admin accountability | Admin changes are recorded in an audit log with the account name | Yes (logged) |
| Recording consent | Upload requires the consent box to be ticked | Yes |
| Server access | Key-based SSH only; Session Manager available | Checked on the server |
| Cloud access | Deployments use a short-lived OIDC token, not stored keys; the server's role is limited to the services it needs | Yes |
| Backups | Private S3 bucket, public access blocked, encrypted at rest | Yes |

## Known limitations
- Customer sessions and admin sessions cannot be ended instantly. A removed or reset user's existing session stays valid until it expires (12 hours).
- Rate limits are kept in memory. A restart clears them.
- The control plane uses the Docker socket, which is effectively root on the host. This is a known risk.
- The site uses HTTP. HTTPS needs a custom domain.
- The sign-in limit counts failures per account. A determined attacker can still try many accounts.
- No independent penetration test or audit has been carried out. No certification (HIPAA, SOC 2) is claimed.

## Tenant isolation: what is and is not proven
Proven by automated tests: separate databases and login roles; one tenant's token rejected by others; one tenant's meetings, recordings and data not visible to another; one customer's deployment does not change another's version or restart its container.

Not proven: a manual, hands-on penetration test of isolation.
