# Security

## Supported trust boundary

A Docker-capable self-hosted runner gives workflow code root-equivalent control
inside its isolated MicroVM. Version 1 therefore supports private repositories
and trusted workflow changes only. Public fork pull requests are unsupported.

## Credentials

- Start uses a short-lived GitHub App installation token. The token is masked
  before validation or external work.
- The encoded JIT configuration and compressed payload are masked and never
  included in errors, outputs, or supervisor logs.
- GitHub-hosted start and stop jobs obtain AWS credentials through OIDC.
- The default MicroVM execution role can write its logs and terminate runner
  MicroVMs. It has no application deployment permissions.
- The runtime role's only unscoped resource permission is
  `lambda:TerminateMicrovm`, because that API does not expose a per-instance IAM
  resource ARN. No other Lambda or application action is granted by it.
- Deployment jobs should assume a separate role through GitHub OIDC.

The GitHub App private key never enters the MicroVM. No long-lived AWS key is
required or documented.

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
