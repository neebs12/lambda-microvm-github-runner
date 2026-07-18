# Warm cache implementation and testing plan

## Status

This document proposes an opt-in warm-cache mode. It is not part of the current
Action contract. The existing `start` and `stop` modes remain the default and
continue to create a new MicroVM and one GitHub JIT runner for each target job.

Warm-cache mode reuses a Lambda MicroVM's disk and memory state for trusted jobs
within the platform's eight-hour maximum lifetime. It does not reuse a GitHub
runner registration. Every target job receives a new JIT configuration, runner
ID, runner name, and unique label.

The intended product description is:

> Reuse a suspended Lambda MicroVM between trusted jobs for up to eight hours.
> Docker layers, package caches, and toolchains survive, while every job uses a
> fresh GitHub JIT runner registration.

## Goals

- Preserve Docker images, Docker build cache, package-manager caches, and
  downloaded toolchains across trusted jobs.
- Suspend the MicroVM between jobs so idle periods do not incur compute charges.
- Retain the current one-job GitHub JIT scheduling model.
- Keep the existing ephemeral workflow unchanged and safe by default.
- Deliver the first working version without DynamoDB or another state service.
- Add cross-workflow discovery and concurrency control only after local
  suspend/resume behavior is proven.
- Continue supporting `overlay2` with the production `vfs` fallback.
- Keep setup script-driven and avoid Terraform.

## Non-goals

- Durable caches beyond the lifetime of one MicroVM.
- Sharing a warm MicroVM between repositories or trust domains.
- Supporting public fork pull requests.
- Making a reused machine equivalent to a clean ephemeral machine.
- Building an internal webhook dispatcher, unbounded queue, or autoscaling
  control plane in the first two phases.
- Preserving a persistent GitHub runner registration between jobs.

## Design principles

### Reuse the machine, not the runner registration

GitHub recommends ephemeral runners for autoscaling and warns that a persistent
runner can receive work while an orchestrator believes that it is unavailable.
Warm-cache mode therefore starts a new JIT runner process for each job. The
process exits and is deregistered after that one job, while the supervisor and
the cached MicroVM remain available for suspension.

See GitHub's
[self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

### Treat reuse as a trust relationship

A workflow has root-equivalent access through Docker and can modify any cache
that a later job consumes. A fresh JIT registration prevents accidental job
assignment to an old runner identity, but it does not clean the filesystem or
memory. Warm reuse is supported only when every job sharing a server key is
equally trusted.

### Make ownership changes conditional

Once DynamoDB is introduced, every lease mutation uses a conditional write and a
monotonically increasing generation. An expired workflow must not be able to
stop or suspend a MicroVM after another workflow has acquired it.

### Keep cleanup layered

Explicit `stop` is the normal path. Workflow `always()` cleanup, on-access
reconciliation, idle suspension, and Lambda's maximum duration are independent
backstops. Warm-cache operations reconcile only the item they touch; there is no
scheduled garbage collector or table scan. DynamoDB TTL eventually removes
expired metadata and is never treated as a MicroVM termination mechanism.

Record the real platform lifetime instead of adjusting the launch timestamp:

```text
platformExpiresAt = observedLaunchTime + maximumDurationSeconds
reuseDeadline = platformExpiresAt - reuseSafetyMarginSeconds
```

The default safety margin is 30 minutes. A MicroVM at or beyond its reuse
deadline is never assigned another job. If it is encountered while still running
or suspended, the Action terminates it idempotently instead of suspending or
resuming it. Nothing executes automatically at the reuse deadline: it is a
decision boundary for the next Action call. An untouched MicroVM remains subject
to Lambda's platform expiry.

Prefer the launch timestamp returned by AWS. If the service response does not
provide one, record the local time immediately before `RunMicrovm`, which
expires the cache conservatively earlier rather than later. The safety margin is
configurable because it cannot guarantee completion of a job that runs longer
than the remaining lifetime.

## Target action contract

The public lifecycle remains the existing two modes:

- `start` without `server-key`: preserve today's ephemeral behavior.
- `start` with `server-key`: lease an available member of that warm server pool,
  or create a member when the request's capacity permits it.
- `stop` with an ephemeral handle or legacy `microvm-id`: terminate the MicroVM.
- `stop` with a warm `server-handle`: conditionally release that exact lease and
  suspend the member. At or beyond its reuse deadline, terminate it instead.

Every Phase 2 warm operation performs targeted reconciliation for its server
pool. There are no additional lifecycle modes and no `gc` mode.

Proposed inputs:

| Input                         | Phase | Purpose                                                                   |
| ----------------------------- | ----- | ------------------------------------------------------------------------- |
| `microvm-id`                  | 1     | Explicit MicroVM used by the Phase 1 proof and legacy termination         |
| `server-key`                  | 1/2   | Repository-scoped warm pool and trust-boundary identity                   |
| `server-capacity`             | 2     | Optional ceiling for this request creating another pool member            |
| `server-handle`               | 1/2   | Exact ephemeral resource or warm member lease returned by `start`         |
| `state-table`                 | 2     | DynamoDB table used for pool discovery and leases                         |
| `lease-timeout-seconds`       | 2     | Deadline for recovering an abandoned lease                                |
| `warm-retention-seconds`      | 2     | Maximum desired suspended retention                                       |
| `reuse-safety-margin-seconds` | 2     | Required lifetime remaining before another job; defaults to 1,800 seconds |

Proposed outputs:

- `label`
- `runner-name`
- `runner-id`
- `microvm-id`
- `image-version`
- `server-handle`
- `warm-hit` in Phase 2
- `warm-expires-at` in Phase 2
- `reuse-deadline` in Phase 2

The `server-handle` identifies one exact resource and lease generation. It must
be masked and must not contain AWS credentials, GitHub tokens, or JIT
configuration data. A stale warm handle fails its conditional release without
making an AWS lifecycle call.

### Request-local capacity semantics

`server-capacity` is deliberately not durable pool configuration. It controls
only whether the current `start` request may add another member when every
existing member is busy:

1. If any healthy member is available, lease it regardless of the supplied
   capacity or current pool size.
2. If none is available and `server-capacity` is omitted, reserve and create a
   new member without an Action-level pool bound.
3. If none is available and the active member count is below the supplied
   capacity, reserve and create one member.
4. Otherwise fail with a clear pool-at-capacity error.

Capacity never shrinks or terminates existing members. If one workflow supplies
`2` and another supplies `3`, the latter can grow the pool to three while the
former can grow it only while fewer than two members exist. Omitting capacity
allows growth to observed concurrency. Users are responsible for keeping
workflow values consistent when they want a stable bound.

## Runtime architecture

Warm mode requires a control path for delivering a new JIT configuration after a
MicroVM resumes. Lambda's `/resume` lifecycle hook has no caller-provided
payload, so it cannot carry the next job's configuration.

The runner image will expose a dedicated control server on a separate port from
the Lambda lifecycle-hook server. The Action will:

1. create or resume the selected MicroVM;
2. create a new repository JIT runner with a unique label;
3. request a short-lived, port-scoped MicroVM authentication token;
4. send the masked JIT payload to the control endpoint;
5. wait for the exact GitHub runner ID and name to become online.

All Lambda MicroVM endpoint requests require a service-issued JWE token. The
Action token will allow only the control port and will expire as soon as
practical. The lifecycle-hook port must not be exposed through the ingress
connector. See the AWS
[MicroVM networking guide](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html).

The control protocol should be small and versioned:

```text
POST /v1/runner/start
{
  "requestId": "collision-resistant idempotency value",
  "microvmId": "expected MicroVM ID",
  "jit": "encoded GitHub JIT configuration"
}
```

The endpoint accepts a request only while the supervisor is idle. Repeating an
accepted `requestId` returns its existing outcome without starting a second
runner. Request bodies, authentication tokens, and JIT values are never logged.

### Supervisor state machine

The warm supervisor extends the current single-use state machine:

```text
SNAPSHOTTED
    |
    v
IDLE <---- runner exits after one job
  |                     ^
  | start fresh JIT     |
  v                     |
STARTING_DOCKER -> STARTING_RUNNER -> RUNNING
  |
  +---- failure ----> FAILED

IDLE -> SUSPENDING -> SUSPENDED -> RESUMING -> IDLE
any non-terminal state -> TERMINATING
```

For an ephemeral launch, the existing behavior remains: runner exit triggers
self-termination. For a warm launch, runner exit clears the process and secret
references, records an idle result, and leaves suspension or termination to
`stop`, idle policy, or the platform duration limit.

The `/suspend` hook must stop Docker and containerd cleanly, flush logs and
filesystem writes, and reject suspension while a runner is busy. Stopping the
daemons must preserve `/var/lib/docker`. The `/resume` hook restarts Docker,
accepting either `overlay2` or the production `vfs` fallback, validates
networking, and leaves the supervisor idle until a new JIT payload arrives.

## Phase 1: explicit warm session without DynamoDB

### Purpose

Prove the core claim with the fewest new moving parts: two different GitHub JIT
jobs use one MicroVM and observe the same Docker cache across a real AWS
suspend/resume boundary.

Workflow outputs carry `microvm-id` between control jobs. There is no automatic
discovery, shared server pool, lease table, or cross-workflow reuse.

### Implementation

1. Extend the AWS client with `SuspendMicrovm`, `ResumeMicrovm`,
   `CreateMicrovmAuthToken`, and the MicroVM endpoint returned by `RunMicrovm`
   and `GetMicrovm`.
2. Extend the existing `start` and `stop` parsing with optional `server-key` and
   `server-handle` inputs. Inputs without a server key or handle must preserve
   today's behavior.
3. Version the run-hook envelope so the image can distinguish `ephemeral` from
   `warm` launches.
4. Add the dedicated authenticated control server to the runner image.
5. Refactor the supervisor so a warm JIT runner exit returns to `IDLE` instead
   of self-terminating.
6. Make suspend stop Docker and containerd cleanly without deleting Docker
   state. Make resume restart and validate them with `vfs` fallback available.
7. Add bounded, full-jitter retries and state polling for suspend and resume.
8. Add the minimum IAM permissions for suspend, resume, and short-lived MicroVM
   endpoint tokens. Do not add DynamoDB permissions yet.
9. Add an experimental workflow that explicitly passes the same `microvm-id`
   through two start/target/stop cycles and finally terminates it with the
   legacy `stop` plus `microvm-id` path.
10. Document that cancellation can leave the experimental VM suspended or
    running until the existing maximum-duration backstop fires.

### Phase 1 example shape

```yaml
prepare-first:
  runs-on: ubuntu-latest
  outputs:
    label: ${{ steps.runner.outputs.label }}
    microvm-id: ${{ steps.runner.outputs.microvm-id }}
    server-handle: ${{ steps.runner.outputs.server-handle }}
  steps:
    - id: runner
      uses: neebs12/lambda-microvm-github-runner@ref
      with:
        mode: start
        server-key: phase1-proof
        # The remaining image, role, token, and Region inputs are unchanged.

first-job:
  needs: prepare-first
  runs-on: ${{ needs.prepare-first.outputs.label }}
  steps:
    - run: docker pull public.ecr.aws/docker/library/node:24
    - run: docker build -t warm-cache-proof .

stop-first:
  if: always()
  needs: [prepare-first, first-job]
  runs-on: ubuntu-latest
  steps:
    - uses: neebs12/lambda-microvm-github-runner@ref
      with:
        mode: stop
        server-handle: ${{ needs.prepare-first.outputs.server-handle }}

prepare-second:
  needs: [prepare-first, stop-first]
  runs-on: ubuntu-latest
  outputs:
    label: ${{ steps.runner.outputs.label }}
    server-handle: ${{ steps.runner.outputs.server-handle }}
  steps:
    - id: runner
      uses: neebs12/lambda-microvm-github-runner@ref
      with:
        mode: start
        server-key: phase1-proof
        microvm-id: ${{ needs.prepare-first.outputs.microvm-id }}

second-job:
  needs: prepare-second
  runs-on: ${{ needs.prepare-second.outputs.label }}
  steps:
    - run: docker image inspect warm-cache-proof
```

The complete test workflow must include a final `stop` job with `if: always()`
that passes the `microvm-id` without a warm handle, exercising the existing
idempotent termination path.

### Phase 1 exit criteria

- The two target jobs have different runner IDs, names, labels, and JIT
  configurations.
- Both target jobs report the same MicroVM ID.
- AWS reports `SUSPENDED` between the target jobs.
- The second job finds the first job's Docker image without pulling or
  rebuilding the unchanged layers.
- Node 24 job containers and Redis service containers work after resume.
- The proof passes with `overlay2` and with forced `vfs` fallback.
- The existing ephemeral E2E matrix remains unchanged and green.
- No JIT value, endpoint authentication token, PAT, or AWS secret appears in
  Action, supervisor, runner, or CloudWatch logs.

## Phase 2: DynamoDB discovery and cross-workflow leases

### Purpose

Allow independent workflow runs to request a repository-scoped server key and
lease healthy suspended MicroVMs from its pool without knowing their IDs.

### Table and IAM setup

The Quickstart script creates one on-demand DynamoDB table using the operator's
existing local AWS credentials. The stored Quickstart IAM user receives only
data-plane access to that exact table. It must not receive `CreateTable`,
`UpdateTable`, or IAM administration permissions.

Suggested keys:

```text
PK = REPOSITORY#<repository-id>#SERVER#<sha256(effective-server-key)>
SK = CONTROL
SK = MEMBER#<member-id>
```

The effective server key includes the user value plus Region, architecture,
image ID and version, execution role, and security-sensitive network
configuration. The `CONTROL` item contains only the transactional member count
and revision needed to reserve creation safely; it does not store an
authoritative capacity. Each `MEMBER` item describes one MicroVM and lease.

Suggested attributes:

| Attribute                    | Purpose                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `memberId`                   | Stable pool member identity                                          |
| `microvmId`                  | AWS resource backing the member                                      |
| `imageId` and `imageVersion` | Prevent reuse after an image change                                  |
| `region`                     | Prevent cross-Region lookup mistakes                                 |
| `state`                      | `CREATING`, `READY`, `LEASED`, `SUSPENDING`, `DESTROYING`, or `DEAD` |
| `leaseId`                    | Opaque current owner token                                           |
| `leaseGeneration`            | Monotonic fencing value                                              |
| `leaseOwner`                 | Repository run ID, attempt, and control job identity                 |
| `leaseExpiresAt`             | Recovery deadline for an abandoned acquisition                       |
| `createdAt`                  | Real service-observed or conservatively recorded launch time         |
| `microvmExpiresAt`           | Platform maximum-duration deadline                                   |
| `reuseDeadline`              | Last safe time at which another job may acquire the MicroVM          |
| `lastUsedAt`                 | Reuse and cleanup metadata                                           |
| `ttl`                        | Eventual metadata removal after the platform deadline                |

Do not store GitHub tokens, JIT configurations, AWS credentials, MicroVM auth
tokens, or workflow secrets in DynamoDB.

### Acquire algorithm

1. Normalize and hash the server key together with repository ID, Region,
   architecture, image ID and version, execution role, and network fingerprint.
2. Read that pool partition consistently and reconcile its expired members.
3. Prefer the most recently used healthy `READY` member whose
   `reuseDeadline > now`. Conditionally change it to `LEASED`, set a new lease
   ID, and increment its generation.
4. If the lease belongs to the same idempotency identity, return or finish the
   previous acquisition instead of acquiring a second member.
5. If no member is available, evaluate this request's `server-capacity`. Omitted
   capacity permits creation; supplied capacity permits creation only when the
   active count is lower.
6. Reserve a `CREATING` member and increment the active count atomically. The
   count check and reservation must be one DynamoDB transaction so simultaneous
   starts cannot overshoot the requesting bound.
7. Launch the reserved member using a client token derived from its identity and
   generation.
8. Resume a reused member when required, create a new JIT registration, deliver
   it through the control endpoint, and wait for the exact runner identity.
9. On any missing, terminal, incompatible, or otherwise unrecoverable member,
   conditionally retire it, correct the active count, and continue through the
   same selection rules.

### Release algorithm

1. Decode the `server-handle` and require the repository identity, server key
   hash, member identity, lease ID, and generation.
2. Verify the GitHub JIT runner is gone or unambiguously idle.
3. Conditionally change `LEASED` to `SUSPENDING` only when the lease ID and
   generation match.
4. Recalculate remaining useful lifetime. At or beyond `reuseDeadline`, change
   the owned item to `DESTROYING`, terminate the MicroVM idempotently, and
   remove or terminally mark the item instead of suspending it.
5. Otherwise suspend the MicroVM and poll until AWS reports `SUSPENDED`.
6. Conditionally change `SUSPENDING` to `READY`, clear lease ownership, and
   record `lastUsedAt`.
7. If a condition fails, make no AWS lifecycle call. A newer owner may have
   acquired the item.

### On-access reconciliation and natural expiry

There is no scheduled cleanup workflow. Warm `start` and `stop` calls reconcile
only the server pool partition named by their inputs or handle. Ordinary
ephemeral `start` and `stop` calls do not scan or mutate warm-cache state.

On each access, the Action:

- repairs an expired `CREATING`, `SUSPENDING`, or `DESTROYING` transition for
  that item;
- treats a missing or platform-terminated MicroVM as stale metadata and replaces
  it;
- terminates an expired MicroVM if AWS still reports it as present;
- retires entries for incompatible or inactive image versions;
- never mutates an unexpired lease owned by another workflow;
- uses the same conditional generation checks as warm `start` and `stop`.

If no workflow touches a member again, Lambda terminates it at its hard maximum
duration. Its table item can remain temporarily without causing a resource leak.
Set its DynamoDB TTL after `microvmExpiresAt` with a metadata grace period. TTL
deletion is deliberately eventual: a later start does not wait for it and
instead rejects the member from its recorded deadline.

Create the `CREATING` item before calling `RunMicrovm` and derive the AWS client
token from the item identity and generation. If the Action stops after the AWS
call but before recording the returned MicroVM ID, a later start can repeat the
idempotent launch and recover the same result. If the key is never touched
again, the platform still terminates the unrecorded MicroVM at its maximum
duration.

This model deliberately accepts that unused suspended MicroVMs continue to
consume regional MicroVM memory quota until their platform or configured
suspended-duration deadline. A shorter `warm-retention-seconds` value can reduce
that window without adding a scheduler.

### Phase 2 exit criteria

- A later workflow run using the same effective server key prefers a healthy
  available pool member and receives a new JIT runner identity.
- Different repositories, Regions, architectures, and image versions cannot
  collide.
- Exactly one workflow can own each member lease generation.
- Concurrent starts can create distinct members up to their request-local
  capacity without overshooting it.
- A request with capacity `3` can grow a pool beyond the ceiling used by a
  request with capacity `2`; the smaller request never shrinks the pool.
- A request without capacity can grow the pool when every member is busy.
- A stale owner cannot stop, suspend, or rewrite a newer lease.
- Cancellation and expired leases recover on the next access without manual
  table edits.
- A missing or terminated MicroVM is replaced without returning its stale label.
- A start at or after `reuseDeadline` creates a replacement instead of resuming
  the old MicroVM.
- A stop at or after `reuseDeadline` terminates instead of suspending.
- The Quickstart setup and teardown scripts create and remove only their exact
  DynamoDB resources and policies.

## Testing strategy

### TypeScript unit tests

Add deterministic tests for:

- parsing every new mode and rejecting conflicting manual/DynamoDB inputs;
- `SuspendMicrovm`, `ResumeMicrovm`, `CreateMicrovmAuthToken`, endpoint parsing,
  and safe handling of `ResourceNotFoundException`;
- suspend and resume polling across every valid and terminal AWS state;
- control-request payload size, validation, masking, and idempotency;
- cleanup after JIT creation, resume, control delivery, and runner-readiness
  failures;
- DynamoDB key normalization and repository scoping;
- conditional start, idempotent retry, stop, and on-access reconciliation;
- fencing behavior with stale lease IDs and generations;
- timestamps at maximum duration, the 30-minute reuse margin, lease expiry, and
  clock boundaries;
- safe user-facing errors that expose no tokens or JIT data.

Use injected clocks, random sources, sleepers, GitHub clients, MicroVM clients,
and DynamoDB clients. Unit tests must not depend on wall-clock sleeps or live
AWS resources.

### Supervisor tests

Extend the Python suite to prove:

- warm `/run` reaches `IDLE` without starting a GitHub runner;
- the control endpoint rejects malformed, oversized, duplicate-conflicting,
  wrong-MicroVM, and non-idle requests;
- an idempotent repeated request does not start a second process;
- JIT runner exit returns warm mode to `IDLE` without self-termination;
- ephemeral mode still self-terminates after runner exit;
- suspend refuses a busy runner and flushes/stops Docker cleanly when idle;
- resume accepts working `overlay2` and the automatic `vfs` fallback;
- terminate stops runner, Docker, containerd, and the control server;
- process arguments, exceptions, and logs never contain the JIT fixture;
- concurrent control calls cannot create two runner processes.

### Local runner-image tests

The packaged ARM64 image test should:

1. start Docker and pull a pinned fixture image;
2. build a uniquely tagged local image and populate BuildKit cache;
3. invoke the suspend hook and verify Docker/containerd stop successfully;
4. invoke the resume hook and verify Docker restarts;
5. verify the image and unchanged build layers still exist;
6. repeat with forced `overlay2` failure and confirm `vfs` fallback preserves
   functional cache state;
7. run a Node container and a Redis service-equivalent container after resume.

Local hook calls do not prove AWS snapshot behavior. They are a fast gate before
the AWS tests.

### AWS Phase 1 E2E

Run in an independent private repository using temporary AWS and GitHub
credentials. Record the workflow URL, MicroVM IDs, runner IDs, labels, image
version, storage driver, and relevant timestamps without recording secrets.

The primary scenario must prove:

1. first warm `start` launches one MicroVM and one JIT runner;
2. the first target populates Docker pull, build, package, and tool caches;
3. warm `stop` reaches AWS `SUSPENDED`;
4. second warm `start` resumes the same MicroVM and starts a different JIT
   runner;
5. the second target proves cache presence and runs container/service-container
   jobs successfully;
6. final legacy `stop` reaches `TERMINATED`;
7. GitHub contains no leftover self-hosted runner registration.

Repeat with:

- target success, failure, timeout, and workflow cancellation;
- warm stop retry and terminating stop retry;
- resume-hook failure and Docker startup failure;
- expired MicroVM maximum duration;
- `overlay2` and forced `vfs` fallback;
- Node 24 job container plus Redis service container;
- no-op build and changed-layer build to distinguish a real cache hit from a
  merely preserved image tag.

### AWS Phase 2 concurrency and recovery E2E

Use a temporary table and repository-scoped IAM policy. Test:

- 20 concurrent starts with capacity `5`: no more than five members are created
  and each successful start owns a different member lease;
- an idempotent rerun of a winning start returns the same lease;
- two different server keys can proceed independently;
- mixed capacity `2` and `3`: the larger request can create the third member,
  the smaller request never shrinks it, and both reuse any available member;
- omitted capacity can create another member when all existing members are busy;
- supplied capacity at or below the active busy-member count fails clearly;
- concurrent count-and-create transactions do not overshoot the requesting
  bound;
- stale stop after a newer generation is acquired: the stop is rejected and the
  newer MicroVM remains running;
- cancellation before JIT delivery, during the target, and during suspend;
- table item exists but MicroVM does not;
- MicroVM exists but table state is stale;
- image version changes between stop and the next start;
- lease expiration followed by on-access reconciliation and another start;
- start one second before, exactly at, and one second after `reuseDeadline`;
- stop before and after `reuseDeadline`;
- allow an untouched suspended MicroVM to reach its platform deadline, then
  verify the next start replaces its stale member;
- expired DynamoDB TTL that has not yet been physically deleted;
- denied suspend/resume/auth-token/DynamoDB permissions with sanitized errors;
- Quickstart teardown with running and suspended test VMs.

### Security tests and review

- Confirm warm mode is rejected for fork-originated pull requests and document
  its trusted-workflow requirement.
- Confirm the control port is inaccessible without a valid MicroVM auth token,
  with an expired token, and with a token scoped to another port.
- Confirm the lifecycle-hook port and shell ingress are not externally exposed.
- Search Action, runner, supervisor, and CloudWatch logs for the JIT fixture,
  PAT fixture, AWS secret fixture, auth-token fixture, and lease fixture.
- Verify the runtime role cannot create endpoint tokens or read the DynamoDB
  table unless explicitly required by the final design.
- Verify target workflow credentials cannot operate the warm-cache control
  plane.
- Demonstrate cache poisoning between two trusted test jobs and document that
  cache reuse is not an isolation boundary.
- Best-effort cleanup should remove `_work` contents, temporary files, stopped
  containers, anonymous volumes, and known credential files without deleting
  Docker layers or configured package caches. Do not claim that cleanup defeats
  a malicious root-equivalent previous job.

### Performance and cost measurements

Collect, but do not initially enforce, these metrics:

- cold MicroVM launch to runner online;
- suspended MicroVM resume to runner online;
- suspend duration;
- first and second Docker pull duration;
- first, unchanged, and changed-layer Docker build duration;
- Node/npm dependency installation duration;
- snapshot bytes written and read where AWS exposes them;
- running compute time, suspended storage time, and warm-cache hit rate;
- behavior as Docker cache size grows.

Phase 1 is successful only if the second job demonstrates an actual local cache
hit. A faster wall-clock result alone is insufficient evidence.

## Failure behavior

| Failure                     | Required result                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------- |
| JIT creation fails          | Do not resume or mutate an available cached VM                                          |
| Resume fails                | Delete unused JIT runner and preserve or destroy VM according to observed state         |
| Control delivery fails      | Delete unused JIT runner; retry only with the same idempotency identity                 |
| Runner never becomes online | Delete JIT runner and suspend or destroy the VM                                         |
| Target job fails            | Warm `stop` still suspends through `always()`                                           |
| Workflow is cancelled       | Lease expires; next access reconciles it and platform duration is the resource backstop |
| Suspend fails               | Do not mark the item `READY`                                                            |
| Stale stop arrives          | Conditional write fails and no AWS lifecycle call is made                               |
| VM is already terminated    | Mark state `DEAD` and replace on the next start                                         |
| Image version changes       | Never resume the old VM for the new key                                                 |

## Documentation and release gates

Before the feature is described as stable:

- add a warm-cache example with an explicit warning about the trust boundary;
- update installation, IAM, security, operations, teardown, and quota docs;
- document snapshot charges and the eight-hour hard lifetime;
- document request-local `server-capacity`, unbounded omission, and
  pool-at-capacity errors;
- preserve the ordinary ephemeral example as the recommended default;
- pass all existing Action and image gates without modifying their expected
  lifecycle;
- pass the full private-repository Phase 1 and Phase 2 matrices;
- review logs manually for secrets;
- publish Action and runner-image SBOMs and checksums;
- keep warm mode experimental until cancellation, stale leases, forced `vfs`,
  and adversarial concurrency tests pass.

Do not move the stable major tag based only on the no-DynamoDB proof. Phase 1 is
an implementation spike and evidence-gathering release; Phase 2 must complete
before warm-cache mode is marketed as cross-workflow functionality.

## Platform references

- [Running and using Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Lambda MicroVM lifecycle and states](https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html)
- [Lambda MicroVM networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#compute-and-storage-microvms)
- [Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [GitHub self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [GitHub self-hosted runner REST API](https://docs.github.com/en/rest/actions/self-hosted-runners)
