# Vespera

**Vespera turns recorded professional meetings into a structured, reviewable draft:** a summary, key points, decisions, tasks, risks and open questions, each linked to the moment it was said in the recording.

Vespera is a multi-tenant SaaS platform. Each customer gets an isolated workspace with its own database, container and storage. It is built on AWS and operated with Infrastructure as Code, automated testing and an approval-gated deployment pipeline.

> Vespera produces drafts for professional review. It is not legal, medical or financial advice, and it does not replace the professional's judgement.

## What it does
- Create meetings with a category, date and participants.
- Upload a recording (MP3, WAV, M4A, MP4 or WebM, up to 600 MB) after confirming consent. Files are stored privately for each customer.
- Transcribe the recording with AWS Transcribe, with timestamps and speaker labels.
- Analyse the transcript with an AI model, producing a summary, key points, decisions, tasks, follow-ups, open questions, risks and review notes.
- Check each owner and deadline: they are kept only when they were spoken in the transcript.
- Edit tasks (owner, deadline, done), add your own tasks, search across transcripts and tasks, and export tasks to CSV.
- Print a report, or download a Word-compatible version.
- Manage a team: administrators add members, reset passwords and remove members.
- Choose a workflow per meeting: legal, B2B sales, healthcare, financial advisory, recruitment and HR, or general.

## Architecture
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: an EC2 server runs Docker. A control plane creates and deploys one container and one PostgreSQL database per customer. Nginx routes each customer's address. Recordings are staged in S3 for transcription, backups are copied to a private encrypted S3 bucket, and CloudWatch monitors the server.

## Cloud and DevOps
| Area | Implemented | Evidence |
|---|---|---|
| Automated tests | 93 checks run on every push | GitHub Actions "Test Vespera" |
| Infrastructure as code | Terraform reads the live server, disk, IP, backup bucket and IAM role; a separate VPC (public and two private subnets) is defined and created | CI "Validate infrastructure code"; `terraform plan` reports no drift |
| Controlled deployment | Manual trigger, reviewer approval, keyless AWS access (OIDC), one customer per run | Deployment run with health check (adhoc, v18) |
| Container images | Built on the server, stored in Amazon ECR with immutable tags, five most recent kept | `aws ecr list-images` shows v18 and v19 |
| Monitoring | CloudWatch CPU and disk alarms with SNS email; a live dashboard | Alarms "Actions enabled"; dashboard shows live data |
| Backups | Nightly database and file backup, copied to private encrypted S3, 3 days kept on the server, 30 days in S3 | A backup was restored into a working database |
| Secure access | Systems Manager Session Manager; password-based SSH is off | Browser session tested; `sshd` settings checked |
| Cost control | AWS budgets (zero-spend and $25), 30-day backup expiry, stop the server when idle | Budgets listed in the console |

## Security
- Each customer's database has its own login role, which cannot reach other customers' databases.
- Passwords are stored as bcrypt hashes. Admin and customer sign-in are rate-limited.
- Customer sessions expire after 12 hours. Admin sessions expire after 12 hours and can be ended.
- Team changes are restricted to administrators, and a workspace always keeps one administrator.
- Storage and backups are private and encrypted; the backup bucket blocks all public access.
- No secrets are stored in this repository.
See [docs/SECURITY-AND-TENANT-ISOLATION.md](docs/SECURITY-AND-TENANT-ISOLATION.md).

## Running the tests
```bash
cd voyage/control-plane
npm ci
sudo env "PATH=$PATH" node test/run.mjs     # expect: ALL CHECKS PASSED (93 checks)
```
The suite uses stand-ins for Docker, GitHub and AWS commands. See [docs/TESTING-REPORT.md](docs/TESTING-REPORT.md) for what is tested live and what is not.

## Documentation
- [Architecture](docs/ARCHITECTURE.md)
- [Testing report](docs/TESTING-REPORT.md)
- [Security and tenant isolation](docs/SECURITY-AND-TENANT-ISOLATION.md)
- [Deployment and CI/CD](docs/DEPLOYMENT-AND-CICD.md)
- [Known limitations](docs/KNOWN-LIMITATIONS.md)
- [Mentor demonstration guide](docs/MENTOR-DEMO.md)
- [Resume description](docs/RESUME.md)
