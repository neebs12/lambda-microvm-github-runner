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

`npm run check` covers strict TypeScript, Action and adversarial DynamoDB tests,
Quickstart IAM credential creation and rotation tests, supervisor tests, and the
bundled Action. Supervisor tests also run successfully under the image's Python
3.9 runtime.

`npm run test:image` requires an ARM64 Docker host. It verifies:

- the image snapshot has no Docker socket;
- immutable runner, Buildx, Compose, and AWS CLI tools;
- asynchronous `/validate` with nested Docker and external registry DNS;
- automatic `fuse-overlayfs` and final `vfs` fallback when `overlay2` cannot
  start;
- `/run`, `/resume`, `/suspend`, and `/terminate`;
- runner process-group and Docker teardown;
- absence of the JIT fixture from logs.

`overlay2`, `fuse-overlayfs`, and `vfs` are supported in AWS. `overlay2` remains
the preferred driver, while `fuse-overlayfs` preserves copy-on-write behavior
when kernel OverlayFS cannot be used. The forced-`vfs` AWS gate uses a small
Alpine build plus Redis to prove final-fallback availability within the 2 GiB
configuration; the full Node 24 image is intentionally avoided with `vfs`
because its complete layer copies can exhaust that filesystem.

The forced-`fuse-overlayfs` AWS gate uses the packaged 2 GiB image. It builds a
Node 24 image with an npm dependency, runs Redis over a user-defined bridge,
checks container DNS and egress, and then suspends and resumes the MicroVM. The
unchanged rebuild must remain fully cached after resume. In the initial proof,
the Docker data root occupied 1.3 GiB and the 7.8 GiB root filesystem retained
4.0 GiB free after the Node, Redis, and BusyBox images were present.

## AWS image gate

Every candidate version must prove in AWS:

- `/ready` snapshots without Docker or registered runner state;
- `/validate` starts Docker with `overlay2`, or automatically falls back through
  `fuse-overlayfs` to `vfs`;
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

Experimental warm-cache release gates additionally require the private
repository matrix in [warm-cache.md](warm-cache.md): two distinct JIT runners on
the same MicroVM across a real suspend/resume boundary, an actual Docker cache
hit, Node 24 and Redis containers, forced `vfs`, fenced stale stops, expiry and
on-access recovery, and concurrent request-local capacity tests. The private
workflow must pin the feature's full commit SHA rather than a branch name.
