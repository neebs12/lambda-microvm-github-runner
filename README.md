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
through the AWS image build hooks with production `overlay2`. Private-repository
end-to-end validation remains a release gate.

## Minimal setup

The setup is two direct scripts. It does not require an infrastructure
framework:

```bash
export AWS_REGION=us-east-1
export GITHUB_REPOSITORY=OWNER/PRIVATE_REPOSITORY

scripts/bootstrap-aws.sh
scripts/build-microvm-image.sh
```

The first command idempotently creates the private S3 artifact bucket,
CloudWatch log groups, GitHub OIDC provider, and three least-privilege IAM
roles. It saves the discovered resource values to `build/aws-setup.json`. The
second command consumes that file automatically and saves the active image
details to `build/microvm-image.json`.

## Usage

The workflow needs an existing active MicroVM image, a least-privilege MicroVM
execution role, AWS credentials obtained through GitHub OIDC, and a short-lived
GitHub App installation token with repository Administration write access.

Copy [examples/basic.yml](examples/basic.yml) into a private repository's
`.github/workflows/` directory, configure the referenced variables and secret,
then pin this Action and its dependencies to reviewed immutable commits.

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
- [security model](docs/security.md)
- [operations and quotas](docs/operations.md)
- [testing and release gates](docs/testing.md)
- [runner image](runner-image/README.md)

## License

MIT
