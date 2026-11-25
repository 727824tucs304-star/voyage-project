# Resume description

**Vespera: AI meeting intelligence platform (multi-tenant SaaS on AWS)**
Designed and built a multi-tenant SaaS platform that turns recorded professional meetings into structured drafts with transcript-linked evidence. Each customer runs in an isolated container with its own database. Built on AWS EC2, S3, Transcribe, IAM, CloudWatch, SNS, Systems Manager and ECR, with Docker, Nginx, PostgreSQL and Node.js.

Cloud and DevOps:
- Described the cloud environment as Terraform code, validated it in CI, and confirmed no drift against the live account.
- Built a GitHub Actions pipeline running 93 automated checks on every push, and an approval-gated deployment that uses keyless OIDC access and rolls back on failed health checks.
- Set up nightly encrypted backups to private S3 storage, and verified a restore into a working database.
- Configured CloudWatch alarms and a dashboard with SNS email alerts, and browser-based server access through Systems Manager.
- Designed a separate VPC with public and private subnets across two availability zones.
- Managed costs with budgets, lifecycle rules and an idle-server routine.

Use "designed for" and "tested" rather than "production-ready", "secure" or "certified".
