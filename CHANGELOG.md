# Changelog

## Unreleased

- Added experimental warm MicroVM reuse with one `server` lifecycle input and
  output, fresh JIT registration per job, explicit no-DynamoDB resume, and
  DynamoDB-backed cross-workflow pools with fenced leases.
- Added request-local `server-capacity`, on-access reconciliation without a
  scheduled garbage collector, `warm-hit` and deadline outputs, and a
  `max-lifetime-seconds` input defaulting to two hours and capped at eight.
- Added authenticated warm supervisor control, snapshot-safe Docker suspension,
  and production `overlay2` validation with the existing `vfs` fallback.
- Quickstart now creates and configures an on-demand warm-state table and grants
  its exact data-plane and MicroVM lifecycle permissions; teardown removes it.
- Guarded Quickstart teardown script that previews by default and deletes
  generated GitHub repository config plus AWS resources with `--yes`.
- Default runner image memory reduced to 2 GiB, plus a container-job and Redis
  service-container example.
- Node.js 24 start/stop Action with strict validation.
- Repository-scoped, single-use JIT runners.
- Deterministic launch idempotency and quota-aware retries/polling.
- Partial-failure and explicit cleanup.
- Snapshot-safe AL2023 ARM64 runner image with Docker, Buildx, and Compose.
- Lifecycle supervisor with fresh Docker startup, automatic production `vfs`
  fallback, and self-termination.
- Direct AWS CLI bootstrap, image build tooling, CI, release SBOMs, and
  examples.
- One-command Classic PAT and static IAM-user Quickstart, with OIDC and GitHub
  App credentials retained as the advanced path.
