# Security

## Supported trust boundary

A Docker-capable self-hosted runner gives workflow code root-equivalent control
inside its isolated MicroVM. Version 1 therefore supports private repositories
and trusted workflow changes only. Public fork pull requests are unsupported.

## Credentials

- Quickstart uses the operator's active local AWS credentials to create or
  reconcile IAM roles, the IAM user, S3, log groups, and other bootstrap
  resources.
- Quickstart stores a classic PAT with `repo` scope and the dedicated IAM user's
  access key as GitHub Actions secrets. That IAM user can use the configured
  image bucket, pass only the exact build/runtime roles, build images, manage
  runner MicroVMs, and access the exact warm-state table. It cannot create or
  modify IAM resources or DynamoDB tables.
- Quickstart is limited to private repositories with trusted workflow changes.
  Rotate or delete both credentials when they are no longer needed.
- Advanced setup uses a short-lived GitHub App installation token and obtains
  AWS credentials through GitHub OIDC.
- GitHub tokens are masked before validation or external work.
- The encoded JIT configuration and compressed payload are masked and never
  included in errors, outputs, or supervisor logs.
- The default MicroVM execution role can write its logs and terminate runner
  MicroVMs. It has no application deployment permissions.
- The runtime role's only unscoped resource permission is
  `lambda:TerminateMicrovm`, because that API does not expose a per-instance IAM
  resource ARN. No other Lambda or application action is granted by it.
- Deployment jobs should use a separate identity and must not inherit the
  Quickstart IAM user's image-build or runner-lifecycle permissions.

The classic PAT, AWS secret access key, and GitHub App private key never enter
the MicroVM.

## Network

Normal launches use managed `NO_INGRESS` and `INTERNET_EGRESS` connectors. Warm
launches require managed `ALL_INGRESS` so the Action can reach the dedicated
control port. Every control request uses a short-lived AWS MicroVM auth token
scoped to that port; the supervisor validates its bounded, versioned payload.
The lifecycle-hook port and shell access are not exposed by this interface.
Private VPC connectors require a separate network and IAM review.

Warm reuse is intentionally a weaker isolation boundary: a trusted job has
root-equivalent control through Docker and can poison files, images, caches, or
memory consumed by a later job. A fresh GitHub JIT registration prevents stale
scheduling but does not make the reused machine clean. Warm mode rejects
fork-originated pull requests and must not be used with untrusted workflow
changes.

## Cleanup

Each execution has independent backstops:

1. the supervisor terminates the MicroVM when the one JIT runner exits;
2. the final workflow job calls terminate idempotently;
3. start cleans up partial launches and unused JIT runners;
4. Lambda enforces `maximumDurationInSeconds`.

Warm mode changes the first two layers: runner exit returns the supervisor to
idle, and `stop` suspends the owned lease (or terminates it at its reuse
deadline). DynamoDB conditional generations fence stale owners. On-access
reconciliation repairs abandoned metadata, DynamoDB TTL eventually deletes old
items, and Lambda's maximum lifetime remains the resource cleanup backstop.
There is no scheduled garbage collector.

## Supply chain

- the Lambda AL2023 base is pinned by digest;
- runner, Docker, AWS CLI, Buildx, and Compose versions are pinned;
- downloaded runner and plugin binaries are SHA-256 verified;
- JavaScript dependencies and the committed bundle are lockfile-controlled;
- CI builds ARM64 and verifies the runner's native dependencies;
- releases attach Action and image SBOMs plus checksums.

Update pins through a reviewed PR. Re-run local, CI, and AWS image validation
after every base, runner, Docker, or supervisor change.
