# Testing

## Local gates

```bash
npm ci
npm run check
shellcheck scripts/*.sh
scripts/package-runner-image.sh
npm run test:image
```

`npm run check` covers strict TypeScript, 53 Action tests, 16 supervisor tests,
and the bundled Action. Supervisor tests also run successfully under the image's
Python 3.9 runtime.

`npm run test:image` requires an ARM64 Docker host. It verifies:

- the image snapshot has no Docker socket;
- immutable runner, Buildx, Compose, and AWS CLI tools;
- asynchronous `/validate` with nested Docker and external registry DNS;
- local-only `vfs` fallback;
- `/run`, `/resume`, `/suspend`, and `/terminate`;
- runner process-group and Docker teardown;
- absence of the JIT fixture from logs.

Local `vfs` success does not replace AWS `overlay2` validation.

## AWS image gate

Every candidate version must prove in AWS:

- `/ready` snapshots without Docker or registered runner state;
- `/validate` starts Docker with `overlay2`;
- Lambda link-local DNS works in containers and BuildKit;
- Buildx builds ARM64;
- Compose Node/Redis bridge DNS and TCP work;
- published-port DNAT and container egress work;
- restart and suspend/resume preserve networking.

## Private repository gate

The manual `.github/workflows/aws-runner-target.yml` job waits for a runner with
the additional `e2e` label. Launch a candidate with that label to exercise
checkout, the ARM64 host, Docker, Buildx, Compose, and a nested container.

Run successful and failing target jobs, Docker builds, service containers,
Compose, cancellation, startup timeout cleanup, duplicate launch retry, two
concurrent workflows, five concurrent starts, simulated throttling, capacity
failure, and denied self-termination fallback.

Do not tag `v1` until logs have been checked for plaintext secrets and the full
private-repository matrix passes.
