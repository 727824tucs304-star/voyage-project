# Deployment and CI/CD

## Pipeline
1. **Push to GitHub.** The CI workflow runs the application test suite (93 checks), builds the customer web app, and validates the Terraform code (format and validate).
2. **Build.** An administrator builds the next version from the latest commit in the admin console. The build refuses to create a second version of a commit that is already built.
3. **Deploy.** The "Deploy to customer" workflow is started by hand, with a customer and a version. It runs only from `main`, waits for a reviewer to approve the `production` environment, connects to AWS with a short-lived OIDC token, and asks the server to deploy through the control plane.
4. **Verify.** The control plane replaces only that customer's container, runs a health check, and rolls back automatically if the check fails. The workflow reports the result.

## Rollback
- Each customer keeps its previous version. The Rollback button or a deployment to the earlier version restores it. Customer data is not touched.

## Environments and secrets
- Secrets stay in the server's `.env` file, which Git ignores. The deployment role holds no long-lived keys.
- The deployment role can only send commands to the one server, using the one deployment script.

## Known limitations
- Deployments are manual and approval-gated by design. There is no automatic production deployment on every push.
- The image is built on the server. Amazon ECR holds copies of recent images, but deployments use the image on the server.
- Each customer is updated in a separate run.
