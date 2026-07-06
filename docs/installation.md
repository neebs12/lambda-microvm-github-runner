# Installation

Version 1 is for private repositories with trusted workflow changes. It requires
an ARM64-capable Lambda MicroVM Region and enough regional MicroVM memory quota
for at least one 4 GiB runner.

## Quickstart

Install these local prerequisites:

- AWS CLI with credentials allowed to create IAM, S3, CloudWatch Logs, and
  Lambda MicroVM resources;
- GitHub CLI authenticated to the target repository;
- `jq`, Docker, and Node.js 24.

Create a classic GitHub personal access token with the `repo` scope. Then clone
this repository and run:

```bash
export AWS_REGION=us-east-1
export GITHUB_REPOSITORY=OWNER/PRIVATE_REPOSITORY

scripts/setup-quickstart.sh
```

Paste the classic PAT when prompted. Alternatively, provide it for unattended
setup:

```bash
GH_PERSONAL_ACCESS_TOKEN=TOKEN scripts/setup-quickstart.sh
```

The script:

1. uses the active local AWS credentials to create or reconcile the S3 bucket,
   CloudWatch log groups, and image build and runtime IAM roles;
2. packages, uploads, validates, and activates the runner image;
3. configures the repository variables;
4. creates a dedicated `lambda-microvm-github-runner-quickstart` IAM user;
5. grants that user only image build and runner lifecycle permissions;
6. rotates its access key directly into the `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY` GitHub Actions secrets;
7. sets the PAT as `GH_PERSONAL_ACCESS_TOKEN`.

The secret access key is never written to the setup output or printed.
Re-running the script reconciles resources, builds a new image version, and
rotates the dedicated access key.

> **Quickstart security boundary:** The local credentials perform privileged
> setup. The stored long-lived credentials cannot mutate IAM resources and are
> limited to the configured image artifacts, exact build/runtime roles, and
> Lambda MicroVM lifecycle. Use them only in private repositories where workflow
> changes are trusted. Never expose them to untrusted `pull_request_target`
> workflows.

Copy [the basic workflow](../examples/basic.yml) into
`.github/workflows/microvm-runner.yml`. Pin Actions to reviewed immutable
versions before production use.

## Verify

Run the workflow manually and confirm:

1. start emits a unique label and MicroVM ID;
2. the target runs on ARM64 and Docker, Buildx, and Compose succeed;
3. the JIT runner processes only that job;
4. the MicroVM reaches `TERMINATED`;
5. no GitHub token, AWS credential, or JIT payload appears in logs.

## Advanced credentials

For short-lived credentials, use GitHub OIDC for AWS and a GitHub App
installation token instead. The standalone bootstrap enables the OIDC provider
and launch role by default. See [advanced credentials](advanced-credentials.md)
and [the advanced workflow](../examples/advanced.yml).
