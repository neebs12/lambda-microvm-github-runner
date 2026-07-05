# Security

## Supported trust boundary

A Docker-capable self-hosted runner gives workflow code root-equivalent control
inside its isolated MicroVM. Version 1 therefore supports private repositories
and trusted workflow changes only. Public fork pull requests are unsupported.

## Credentials

- Quickstart stores a classic PAT with `repo` scope and a dedicated IAM user's
  access key as GitHub Actions secrets. The IAM user can reconcile this
  product's bootstrap resources, build images, and manage runner MicroVMs.
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
  Quickstart IAM user's bootstrap permissions.

The classic PAT, AWS secret access key, and GitHub App private key never enter
the MicroVM.

## Network

Normal launches use managed `NO_INGRESS` and `INTERNET_EGRESS` connectors. There
is no public endpoint, shell token, or inbound debug path. Private VPC
connectors require a separate network and IAM review.

## Cleanup

Each execution has independent backstops:

1. the supervisor terminates the MicroVM when the one JIT runner exits;
2. the final workflow job calls terminate idempotently;
3. start cleans up partial launches and unused JIT runners;
4. Lambda enforces `maximumDurationInSeconds`.

## Supply chain

- the Lambda AL2023 base is pinned by digest;
- runner, Docker, AWS CLI, Buildx, and Compose versions are pinned;
- downloaded runner and plugin binaries are SHA-256 verified;
- JavaScript dependencies and the committed bundle are lockfile-controlled;
- CI builds ARM64 and verifies the runner's native dependencies;
- releases attach Action and image SBOMs plus checksums.

Update pins through a reviewed PR. Re-run local, CI, and AWS image validation
after every base, runner, Docker, or supervisor change.
