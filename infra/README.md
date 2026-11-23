# Vespera infrastructure (Terraform)

This folder describes the existing Vespera AWS environment as code.

## What it does now
- Looks up the application server, its Elastic IP, its root disk, its backup bucket and its IAM role.
- Shows the key facts as outputs.
- Changes nothing in AWS. Every block is a read-only data source.

## Safety
- No resources are created, modified or deleted.
- No secrets are stored in this folder.
- The state file stays out of Git (see .gitignore).

## Commands
```
terraform fmt -check -recursive
terraform init
terraform validate
terraform plan
```

`terraform plan` should report "No changes" and list the data sources it read.

## Next phase (needs approval)
Import the server, disk, bucket and role as managed resources, with `prevent_destroy` set,
so no plan can delete them.
