# Advanced credentials

The advanced path replaces the Quickstart's static AWS access key and classic
GitHub PAT with short-lived credentials. Runner behavior and AWS resources are
otherwise identical.

## 1. Create the AWS resources and image

Use local AWS credentials that can create IAM roles, an IAM OIDC provider, an S3
bucket, and CloudWatch log groups:

```bash
export AWS_REGION=us-east-1
export GITHUB_REPOSITORY=OWNER/PRIVATE_REPOSITORY

scripts/bootstrap-aws.sh
scripts/build-microvm-image.sh
scripts/configure-github.sh
```

The bootstrap creates a GitHub OIDC launch role trusted only for the
repository's `main` branch. Set `GITHUB_DEFAULT_BRANCH` for another branch, or
set `GITHUB_OIDC_SUBJECT` to an exact GitHub Environment or ref subject. Do not
use a wildcard subject for untrusted pull-request refs.

No IAM user or stored AWS access key is required by GitHub in this mode.

## 2. Create a GitHub App

Create and install a GitHub App only on the runner repository. Grant repository
Administration read/write permission so it can create, inspect, and delete JIT
runners.

Record its App ID and download its private key, then configure them:

```bash
gh variable set RUNNER_APP_ID --body APP_ID
gh secret set RUNNER_APP_PRIVATE_KEY < path/to/app.private-key.pem
```

The helper can configure these values with the other repository settings:

```bash
RUNNER_APP_ID=APP_ID \
RUNNER_APP_PRIVATE_KEY_FILE=path/to/app.private-key.pem \
scripts/configure-github.sh
```

## 3. Configure the workflow

Copy [the advanced workflow](../examples/advanced.yml) into
`.github/workflows/microvm-runner.yml`. It requests `id-token: write`, assumes
the repository-scoped AWS launch role, and mints a short-lived GitHub App
installation token for each start job.
