# Mentor demonstration guide (about 10 minutes)

## Before the demo
- Start the EC2 server and check that the workspaces respond (`docker ps` shows them as Up).
- Sign in to the admin console and to the adhoc workspace.
- Open a completed meeting in a tab. Keep the printed report ready.
- Check the free AI allowance has not been used up for the day.

## Flow
1. **The problem (1 min).** Meetings create follow-up work. Vespera drafts the structure, and each point links to the recording.
2. **Customer workspace (1 min).** Show Overview and Meetings. Explain separate workspaces.
3. **Completed meeting (3 min).** Open the transcript (timestamps and speakers). Open the analysis. Click a timestamp to jump to the transcript. Point out the "Draft for review" label. Show that an owner or deadline appears only when it was spoken.
4. **Tasks and search (2 min).** Tick a task, add one, and search for a phrase that was said.
5. **Report (1 min).** Show the printed report and the review signature line.
6. **Team (1 min).** Show how an administrator adds a member, and that members cannot change the team.
7. **Cloud (2 min).** Show the architecture diagram, the Terraform plan with no drift, the GitHub Actions run, the CloudWatch dashboard, and the approval-gated deployment history.

## Questions to expect
- *Is the summary accurate?* It is a draft. Owners and deadlines are kept only when spoken. Every point links to the recording.
- *Is it secure?* Customer data is separated per customer. Passwords are hashed, sign-in is rate-limited, and admin actions are logged. It has not been penetration-tested and holds no certification.
- *Can it handle long meetings?* Yes, slowly. A one-hour meeting completed on the free tier; very long meetings or heavy daily use can hit the free limit.
- *What would it cost?* Almost nothing at demo scale, using free tiers and stopping the server when idle.
- *What is not built?* HTTPS on a custom domain, email-based password reset, native Word files, and direct CRM integration.
