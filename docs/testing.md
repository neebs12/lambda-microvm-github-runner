# Testing

## Local gates

```bash
npm ci
npm run check
shellcheck scripts/*.sh test/scripts/*.sh
scripts/package-runner-image.sh
npm run test:image
npm audit --audit-level=high
```

`npm run check` covers strict TypeScript, 58 Action tests, Quickstart IAM
credential creation and rotation tests, 18 supervisor tests, and the bundled
Action. Supervisor tests also run successfully under the image's Python 3.9
runtime.

`npm run test:image` requires an ARM64 Docker host. It verifies:

- the image snapshot has no Docker socket;
- immutable runner, Buildx, Compose, and AWS CLI tools;
- asynchronous `/validate` with nested Docker and external registry DNS;
- automatic `vfs` fallback when `overlay2` cannot start;
- `/run`, `/resume`, `/suspend`, and `/terminate`;
- runner process-group and Docker teardown;
- absence of the JIT fixture from logs.

Both `overlay2` and `vfs` are supported in AWS. `overlay2` remains the preferred
driver because it is faster and more storage-efficient.

## AWS image gate

Every candidate version must prove in AWS:

- `/ready` snapshots without Docker or registered runner state;
- `/validate` starts Docker with `overlay2`, or automatically falls back to
  `vfs`;
- Lambda link-local DNS works in containers and BuildKit;
- Buildx builds ARM64;
- Compose Node/Redis bridge DNS and TCP work;
- published-port DNAT and container egress work;
- restart and suspend/resume preserve networking.

## Private repository gate

The manual `.github/workflows/aws-runner-e2e.yml` workflow exercises the
production three-job pattern through the GitHub OIDC role. Set a temporary
`RUNNER_E2E_TOKEN` repository secret with Administration read/write permission,
then run its `success`, `failure`, `startup-timeout`, and `maximum-duration`
scenarios. For `cancellation`, cancel the run while its target waits. Remove the
secret after testing. The workflow verifies checkout, the ARM64 host, Docker,
Buildx, Compose, service containers, DNS, egress, partial-start cleanup, job
failure and cancellation cleanup, idempotent stop, and the platform duration
backstop.

The lower-level `.github/workflows/aws-runner-target.yml` job remains available
for a runner launched outside GitHub Actions. It waits for a runner with the
additional `e2e` label.

Run successful and failing target jobs, Docker builds, service containers,
Compose, cancellation, startup timeout cleanup, duplicate launch retry, two
concurrent workflows, five concurrent starts, simulated throttling, capacity
failure, and denied self-termination fallback.

Do not tag `v1` until logs have been checked for plaintext secrets and the full
private-repository matrix passes. CI and release builds print all image findings
and fail on fixable critical vulnerabilities. High findings remain visible and
must be reviewed when advancing the pinned upstream runner, Docker, Buildx,
Compose, and AWS CLI versions. Every release publishes Action and runner-image
SBOMs with checksums.
