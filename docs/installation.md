# Installation

Version 1 is for private repositories with trusted workflow changes. It requires
an ARM64-capable Lambda MicroVM Region and an AWS account with enough MicroVM
memory quota for at least one 4 GiB runner.

## 1. Create the AWS resources

Use local AWS credentials that can create IAM roles, an IAM OIDC provider, an S3
bucket, and CloudWatch log groups:

```bash
export AWS_REGION=us-east-1
export GITHUB_REPOSITORY=OWNER/PRIVATE_REPOSITORY

scripts/bootstrap-aws.sh
```

This direct, idempotent script creates:

- one private, encrypted, versioned S3 artifact bucket;
- build and runtime CloudWatch log groups with 30-day retention;
- the account-level GitHub Actions OIDC provider if it is absent;
- an image build role;
- a restricted MicroVM runtime role;
- a GitHub OIDC launch role trusted only for the repository's `main` branch.

It writes the resulting values to `build/aws-setup.json`. Run it again to
reconcile the same resources.

For a different default branch, set `GITHUB_DEFAULT_BRANCH`. For a GitHub
Environment or another exact OIDC subject, set `GITHUB_OIDC_SUBJECT` explicitly.
Do not use a wildcard subject for untrusted pull-request refs.

No IAM user or stored AWS access key is needed by GitHub.

## 2. Build the MicroVM image

The build command reads `build/aws-setup.json` automatically:

```bash
scripts/build-microvm-image.sh
```

It packages and uploads a content-addressed artifact, creates or updates the
image, waits for validation, activates the successful version, and keeps a
bounded rollback set. The active ARN and version are written to
`build/microvm-image.json`.

## 3. Create a GitHub App

Create and install a GitHub App only on the runner repository. Grant repository
Administration read/write permission so it can create, inspect, and delete JIT
runners.

Record its App ID and download its private key. A compatible fine-grained PAT
can be passed directly, but short-lived installation tokens are preferred.

## 4. Configure the GitHub repository

With `gh auth status` working, set the generated AWS and image values:

```bash
scripts/configure-github.sh
```

Then set the GitHub App credentials:

```bash
gh variable set RUNNER_APP_ID --body APP_ID
gh secret set RUNNER_APP_PRIVATE_KEY < path/to/app.private-key.pem
```

Alternatively, configure everything in the helper invocation:

```bash
RUNNER_APP_ID=APP_ID \
RUNNER_APP_PRIVATE_KEY_FILE=path/to/app.private-key.pem \
scripts/configure-github.sh
```

The helper creates these repository variables:

- `MICROVM_AWS_REGION`;
- `MICROVM_LAUNCH_ROLE_ARN`;
- `MICROVM_EXECUTION_ROLE_ARN`;
- `MICROVM_RUNTIME_LOG_GROUP`;
- `MICROVM_RUNNER_IMAGE_ARN`;
- `MICROVM_RUNNER_IMAGE_VERSION`.

Copy [the basic workflow](../examples/basic.yml) into
`.github/workflows/microvm-runner.yml`. Pin every third-party Action and this
Action to reviewed immutable commits before production use.

## 5. Verify

Run the workflow manually and confirm:

1. start emits a unique label and MicroVM ID;
2. the target runs on ARM64 and `docker info`, Buildx, and Compose succeed;
3. the JIT runner processes only that job;
4. the MicroVM reaches `TERMINATED`;
5. no GitHub token or JIT payload appears in Actions or CloudWatch logs.
