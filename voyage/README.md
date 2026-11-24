# Vespera: AI meeting intelligence on AWS

Vespera turns recorded professional meetings into a structured, reviewable draft: summary, decisions, tasks, risks and open questions, each linked to the exact moment in the recording. It is built as a multi-tenant SaaS platform: every customer gets an isolated workspace with its own database, container and storage.

> Vespera produces drafts for professional review. It is not legal, medical or financial advice.

## Architecture

```
                 Internet
                     |
            [ Nginx (Docker) ]  routes by customer subdomain
                     |
   +-----------------+------------------+
   |                                    |
[ Control plane ]                [ Customer containers ]
  admin console, registration,      one per customer, each with
  deployments, builds, billing,     its own database and storage
  usage metering, AWS cost sync
   |
[ PostgreSQL ]  one database per customer, plus the control database
   |
   +--> AWS Transcribe (audio staged in S3, then deleted)
   +--> Groq AI (transcript analysis)
   +--> AWS Cost Explorer (cost reporting)

Nightly:  backup -> local copy -> private, encrypted S3 bucket (Mumbai)
Daily:    health check -> log
Every push: GitHub Actions -> automated tests and Terraform validation
```

Full description, data flows and known limits: [`voyage/docs/ARCHITECTURE.md`](voyage/docs/ARCHITECTURE.md).

## Cloud and DevOps features

| Area | What is implemented | How it is verified |
|---|---|---|
| Automated testing | 91-check test suite, run on every push | GitHub Actions, "Test Vespera" job |
| Infrastructure as code | Terraform describes the existing server, disk, IP, backup bucket and IAM role (read-only) | GitHub Actions, "Validate infrastructure code" job; `terraform plan` against the live account |
| Backups | Nightly database and file backup, copied to a private encrypted S3 bucket | A backup was restored into a working database |
| Monitoring | CloudWatch CPU and disk alarms, with email alerts through SNS; a live dashboard | Alarms in "Actions enabled"; dashboard shows live metrics |
| Secure access | Systems Manager Session Manager; key-only SSH | Browser terminal session tested |
| Access control | Personal admin accounts, hashed passwords, expiring sessions, rate limits, audit log | Automated tests |
| Multi-tenancy | Separate database, container and storage per customer; separate database roles | Automated tests and live customers |
| Cost control | Backups expire after 30 days; Elastic IP; server can be stopped when idle | Lifecycle rule enabled |

## Running the tests

The control-plane suite needs PostgreSQL 16 and Node.js 22. It uses stand-ins for Docker, GitHub and AWS, so it runs without any cloud access.

```bash
cd voyage/control-plane
npm ci
sudo env "PATH=$PATH" node test/run.mjs
```

Expected result: `ALL CHECKS PASSED` (91 checks).

To validate the infrastructure code:

```bash
cd voyage/infra
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

## Cost

The main running cost is one small EC2 server (t3.micro), plus a few small charges for storage, the static IP address and monitoring. Estimates, checked against AWS pricing for ap-south-1 at the time of writing:

- Server, running continuously: roughly USD 15 to 17 per month.
- Stopped server: disk and IP only, roughly USD 6 per month.
- Backup storage and alarms: well under USD 1 per month at current data size.

The project runs on AWS credits. The server is stopped when it is not being demonstrated.

## Security

- The server's permissions are limited to the services it uses: writing and reading one backup bucket, transcription, cost reporting, monitoring and Session Manager.
- Database access is private. Each customer's database has its own login.
- Backups are encrypted at rest and the bucket blocks all public access.
- No secrets are stored in this repository. Configuration lives in a server file that Git ignores.

## Known limits

- The site is served over HTTP. HTTPS needs a domain name.
- The control plane uses the Docker socket, which is effective root on the host. This is a known risk.
- Analysis uses a free AI tier with daily token limits.
- No independent security audit or certification has been done.
- Infrastructure changes are not yet applied through Terraform; the Terraform code currently only reads the live environment.

## Roadmap

1. Controlled deployments from the pipeline, one customer at a time, with a health check and rollback.
2. Container images stored in Amazon ECR, versioned by commit.
3. Terraform management of the server and its supporting resources, after review.
4. HTTPS on a custom domain.
5. Presigned direct uploads for recordings.

## Repository layout

| Path | Contents |
|---|---|
| `voyage/control-plane/` | Admin console, provisioning, deployments, billing, backups |
| `voyage/tenant-app/` | Customer workspace (React and Node.js) |
| `voyage/infra/` | Terraform description of the cloud environment |
| `voyage/docs/` | Architecture and operations documents |
| `.github/workflows/` | Continuous integration |
