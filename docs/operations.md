# Operations

## Quickstart teardown

Preview the resources that would be deleted:

```bash
export GITHUB_REPOSITORY=OWNER/REPOSITORY
scripts/teardown-quickstart.sh
```

Delete them:

```bash
scripts/teardown-quickstart.sh --yes
```

The script requires the generated `build/aws-setup.json` file and uses
`build/microvm-image.json` when present. It deletes only the resource names and
ARNs recorded there: repository secrets and variables, the dedicated Quickstart
IAM user, project IAM roles, the MicroVM image, the warm-state table, the
versioned artifact bucket, and build/runtime log groups.

## Quickstart credential rotation

Re-run the credential helper to rotate the dedicated IAM user's access key and
replace both GitHub Actions secrets:

```bash
export GITHUB_REPOSITORY=OWNER/REPOSITORY
scripts/configure-quickstart-credentials.sh
```

Run it with local AWS credentials allowed to manage that IAM user, its inline
policy, and its access keys. The stored Quickstart credentials intentionally
cannot rotate themselves or change IAM policy.

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

Warm members consume regional MicroVM memory quota while running or suspended.
`server-capacity` is a request-local creation ceiling, not persistent pool
configuration: an available member is always reused; if all are busy, an omitted
bound permits growth and a supplied bound rejects creation once the active count
reaches it. Mixed bounds are intentionally allowed and the largest successful
request can grow the pool. Use GitHub concurrency controls when a repository
needs a stable operational bound.

`max-lifetime-seconds` defaults to 7,200 and cannot exceed Lambda's
28,800-second limit. A member inside the configured safety margin is terminated
instead of reused. Untouched members naturally expire at their platform
deadline; the next warm action reconciles stale table state. No scheduled
garbage collector or table scan is required.

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

For warm pools, inspect the exact `MICROVM_WARM_STATE_TABLE` partition when a
pool reports no capacity. Do not edit lease IDs or generations manually while a
workflow may still own them. Teardown removes the whole project table; preview
its resource list before using `--yes`.

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
- Docker validation failure: inspect the supervisor log for both `overlay2` and
  `vfs` startup failures. `vfs` is the automatic production fallback.
- `vfs` out of space: the fallback copies complete filesystem layers and is
  substantially more storage-intensive than `overlay2`. On the 2 GiB runner,
  prefer smaller base images and bounded caches; a large Node image plus service
  images can exhaust the snapshot filesystem even though the same workload fits
  with `overlay2`.
- self-termination denied: correct the runtime role; the explicit stop job and
  maximum duration remain active.
