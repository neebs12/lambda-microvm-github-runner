# Operations

## Quickstart credential rotation

Re-run the credential helper to rotate the dedicated IAM user's access key and
replace both GitHub Actions secrets:

```bash
export GITHUB_REPOSITORY=OWNER/REPOSITORY
scripts/configure-quickstart-credentials.sh
```

The helper installs the new secret pair before deleting the previous key. Rotate
the classic PAT separately with:

```bash
gh secret set GH_PERSONAL_ACCESS_TOKEN --repo "${GITHUB_REPOSITORY}"
```

Delete the dedicated IAM user and PAT when the integration is no longer used.

## Quotas

MicroVM API and memory quotas are shared per AWS account and Region. The
documented baseline includes 5 `RunMicrovm` requests per second with burst 5, 10
`TerminateMicrovm` requests per second with burst 10, and 100 `GetMicrovm`
requests per second with burst 100.

The Action uses bounded full-jitter launch and termination retries, a stable
launch client token, an initial polling spread of up to 5 seconds, randomized
sequential polling at 2.5–5 second intervals, and immediate failure for capacity
exhaustion. The defaults keep a simulated 200 simultaneous starts within the 100
`GetMicrovm` requests-per-second baseline. For sustained rates above the launch
quota, request a quota increase or shape GitHub workflow concurrency. Do not add
an internal queue to this product.

## Logs

The AWS bootstrap creates build and runtime log groups with retention. Action
logs contain non-secret stage and resource metadata. Supervisor logs contain
lifecycle state, Docker failure tails, process exit codes, and cleanup outcomes,
but never hook bodies or JIT values.

## Orphan audit

Periodically inspect running and suspended MicroVMs:

```bash
aws lambda-microvms list-microvms \
  --region us-east-1 \
  --query 'items[?state==`RUNNING` || state==`SUSPENDED`].[microvmId,state,startedAt,imageArn]' \
  --output table
```

Investigate runners near their maximum duration and terminate confirmed orphans.
Alert on repeated self-termination failures or VMs consistently reaching the
duration backstop.

## Image updates and rollback

The build script activates a version only after its `/ready` and `/validate`
hooks succeed. It then makes older versions inactive and retains a bounded
rollback set. Workflows should pin `image-version`.

To roll back:

```bash
aws lambda-microvms update-microvm-image-version \
  --image-identifier IMAGE_ARN \
  --image-version PREVIOUS_VERSION \
  --status ACTIVE
```

Update the repository's `MICROVM_RUNNER_IMAGE_VERSION` variable after the
version is active.

## Common failures

- `ServiceQuotaExceededException`: inspect regional MicroVM memory quota and
  currently running/suspended VMs.
- image inactive or missing: verify the pinned ARN/version and activation
  status.
- runner remains offline: inspect `/run`, Docker, DNS, and GitHub egress logs;
  start cleanup should terminate the VM.
- Docker validation failure: production must use `overlay2`; never enable the
  local `vfs` fallback in AWS.
- self-termination denied: correct the runtime role; the explicit stop job and
  maximum duration remain active.
