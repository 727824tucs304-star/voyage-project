# Testing report

## Automated suite (control plane, 93 checks)
Run on every push by GitHub Actions. Result on the latest verified run: **93 of 93 passed**.

The suite starts a real control plane and real tenant processes against a local PostgreSQL 16. Docker, GitHub and AWS CLI commands are replaced by stand-ins, so the suite tests the application logic and its database behaviour, not the live AWS services.

Areas covered:
1. Input validation for registration, uploads and admin calls.
2. Five-customer registration and automated provisioning.
3. Isolation: separate databases, roles and containers; nginx routing; health checks; password hashes cleared.
4. Tenant application: sign-in, rejection of wrong passwords, rejection of unauthenticated requests, meeting create and update, persistence across a container restart.
5. Data isolation across five tenants, and rejection of one tenant's token by the others.
6. Independent version deployment, upgrade of one customer, rollback, and no effect on other customers.
7. Deployment Manager with a GitHub connection: change detection, deployment to one customer only, deployment history, and rejection of invalid requests.
8. Usage metering, billing allocation and pricing rules; the AWS cost sync and its error reporting.
9. Vespera meetings: create, validate, upload rules (type, consent, size), private storage, search and filters, deletion.
10. Product line: Vespera starts at V1 separately from legacy Voyage releases; migration keeps data.
11. Archive and restore of a workspace.
12. Transcription pipeline (test provider), AI analysis (test provider): timestamps linked, owners not invented.
13. Tasks, search and workflow selection.
14. Printable report: content, escaping of user text, Word download headers.
15. Removal of a recording clears its derived results.
16. Admin accounts: sign-in, sessions, rate limits.
17. Healthcare, financial and HR categories.
18. Prescriptions: cost rules and budget comparison.
19. Customer sign-in limit.
20. Team management: add members, admin-only changes, password reset, removal rules.

**Important:** the travel-planner checks were replaced with equivalent meeting checks, not weakened. Their guarantees (isolation, data kept through changes, invalid input refused) are still tested.

## Live testing (performed on the real AWS environment)
- Upload of a 60-minute council recording, transcription and AI analysis completed.
- Upload of a 26 MB recording; removal of a wrong recording.
- Controlled deployment of v18 to the adhoc workspace through GitHub approval; health check passed; the workspace reported v18.
- Restore of the control database from S3 into a scratch database.
- CloudWatch alarm, dashboard and disk metrics.
- Session Manager browser session.
- Terraform plan against the live account: no drift.

## Not tested
- The screens in a browser, across browsers and phone sizes. A visual review is still needed.
- The demo seed on a live workspace (the seed is written but has not been run against a workspace yet).
- A full end-to-end run of the final build on every customer.
- Real AI or transcription output quality across different recordings.
- Penetration testing or an independent security review.
