# Lambda MicroVM GitHub Runner

A repository-scoped JavaScript Action for launching one single-use GitHub
Actions runner on an AWS Lambda MicroVM.

## Status

The Action implements and tests:

- strict mode-dependent Action input parsing;
- collision-resistant runner identity and deterministic launch client tokens;
- masked gzip/base64 JIT payloads with a 4,096-byte limit;
- bounded full-jitter retry and quota-aware polling;
- repository JIT creation and exact-runner readiness polling;
- idempotent Lambda MicroVM launch, readiness, cleanup, and termination;
- typed GitHub and AWS adapters with mocked-boundary integration tests.

The production AL2023 runner image is implemented and validated locally and
through the AWS image build hooks with production `overlay2`. The complete
private-repository workflow is validated for success, job failure, cancellation,
startup timeout, service containers, and the maximum-duration backstop.

## Quickstart

Install the AWS CLI, GitHub CLI, `jq`, Docker, and Node.js 24. Authenticate both
CLIs, create a classic GitHub PAT with the `repo` scope, then run:

```bash
export AWS_REGION=us-east-1
export GITHUB_REPOSITORY=OWNER/PRIVATE_REPOSITORY

scripts/setup-quickstart.sh
```

The script creates the AWS resources and runner image, configures the
repository, creates a dedicated IAM user, rotates its static access key directly
into GitHub Actions secrets, and prompts for the classic PAT. It does not use an
infrastructure framework or write the AWS secret access key to disk.

The Quickstart IAM user deliberately includes bootstrap, image build, and runner
lifecycle permissions. Use it only with private repositories and trusted
workflow changes. See [advanced credentials](docs/advanced-credentials.md) to
replace both long-lived credentials with GitHub OIDC and a GitHub App.

## Usage

Copy [examples/basic.yml](examples/basic.yml) into the private repository's
`.github/workflows/` directory. The Quickstart script configures every variable
and secret referenced by this workflow.

The start job emits a unique label for one target job. The runner is JIT-only
and single-use. Its supervisor self-terminates after that job; the explicit stop
job and platform maximum duration are independent cleanup backstops.

## Development

Node.js 24 is required.

```bash
npm ci
npm run check
```

`dist/index.js` is committed because GitHub Actions executes the bundled
artifact directly.

## Product boundaries

Version 1 is ARM64, JIT-only, repository-scoped, and intended for private
repositories with trusted workflow changes. It has no webhook, queue,
dispatcher, warm pool, shell ingress, persistent runner, or boot-time package
installation.

Detailed guides:

- [installation](docs/installation.md)
- [advanced credentials](docs/advanced-credentials.md)
- [security model](docs/security.md)
- [operations and quotas](docs/operations.md)
- [testing and release gates](docs/testing.md)
- [runner image](runner-image/README.md)

## License

MIT
